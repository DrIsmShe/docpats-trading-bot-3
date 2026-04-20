/**
 * PositionMonitor — программный мониторинг SL/TP.
 *
 * Binance запрещает STOP_MARKET ордера через /fapi/v1/order (-4120),
 * поэтому SL/TP реализован программно:
 *   - Каждые N секунд запрашивает позиции с биржи (getPositions)
 *   - Сверяет: если в БД OPEN, а на бирже уже нет — закрывает в БД (reconcile)
 *   - Иначе сравнивает текущую цену с SL/TP из MongoDB
 *   - При достижении — закрывает MARKET ордером через closeMarketOrder
 *     (reduceOnly=true, не может перевернуть позицию)
 *   - Верифицирует закрытие через getPositions(); если позиция всё ещё
 *     видна на бирже — оставляет запись OPEN, алертит, повторит на
 *     следующем tick (reconcile в начале _checkPosition подхватит).
 *
 * [GAP #1] Reconcile в начале каждого _checkPosition: если позиция на
 *   бирже уже отсутствует — просто закрываем в БД, не шлём новый close.
 *   Это предотвращает бесконечный цикл "close → reduceOnly rejected (-2022)"
 *   после неудачной верификации на прошлом тике.
 *
 * [GAP #2] reconcileOnStartup() — вызывать один раз при старте бота,
 *   ДО запуска основного цикла. Убирает рассинхрон БД↔биржа после падений
 *   в момент между placeMarketOrder и store.close().
 *
 * Запускается параллельно с основным циклом бота.
 */
export class PositionMonitor {
  constructor({
    binanceClient,
    breakoutStore,
    mlOnlyStore,
    pollIntervalMs = 5000, // проверка каждые 5 секунд
    telegram = null,
  }) {
    this.binanceClient = binanceClient;
    this.stores = [
      { store: breakoutStore, name: "Breakout" },
      { store: mlOnlyStore, name: "ML-Only" },
    ];
    this.pollIntervalMs = pollIntervalMs;
    this.telegram = telegram;
    this._timer = null;
    this._running = false;
    this._priceCache = {};
    this._priceCacheTs = {};
    this._PRICE_TTL = 2000; // кэш цены 2 секунды
  }

  start() {
    if (this._timer) return;
    console.log(
      `\n🛡️  PositionMonitor запущен (интервал: ${this.pollIntervalMs / 1000}s)`,
    );
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
    // Первый тик сразу
    this._tick();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      console.log(`\n🛡️  PositionMonitor остановлен`);
    }
  }

  async _getPrice(symbol) {
    const now = Date.now();
    if (
      this._priceCache[symbol] &&
      now - this._priceCacheTs[symbol] < this._PRICE_TTL
    ) {
      return this._priceCache[symbol];
    }
    const price = await this.binanceClient.getPrice(symbol);
    this._priceCache[symbol] = price;
    this._priceCacheTs[symbol] = now;
    return price;
  }

  /**
   * [GAP #2] Стартовый reconcile: сверяет состояние БД и биржи ОДИН РАЗ
   * при старте бота. Вызывать из server.js до запуска основного цикла
   * и до PositionMonitor.start().
   *
   * Два направления:
   *   1) DB OPEN, биржа пустая → закрываем в БД как RECONCILE_STARTUP
   *      (бот упал между fill и store.close — восстанавливаем консистентность)
   *   2) Биржа OPEN, DB пустой → Telegram-алерт, НЕ закрываем автоматически
   *      (бот не знает SL/TP/entry этой позиции — ручной разбор)
   */
  async reconcileOnStartup() {
    console.log(`\n🔧 PositionMonitor: startup reconcile...`);
    let exchangePositions;
    try {
      exchangePositions = await this.binanceClient.getPositions();
    } catch (err) {
      console.error(
        `❌ Startup reconcile: getPositions() failed: ${err.message}`,
      );
      if (this.telegram) {
        await this.telegram
          .send(
            `⚠️ Startup reconcile skipped: getPositions() failed\n` +
              `Error: ${err.message}`,
          )
          .catch(() => {});
      }
      return;
    }

    // Направление 1: DB OPEN, но на бирже нет
    for (const { store, name } of this.stores) {
      let dbOpen;
      try {
        dbOpen = await store.getOpenPositions();
      } catch (err) {
        console.error(
          `❌ Startup reconcile [${name}]: store.getOpenPositions() failed: ${err.message}`,
        );
        continue;
      }

      for (const pos of dbOpen) {
        const onExch = exchangePositions.find(
          (p) => p.symbol === pos.symbol && Math.abs(p.positionAmt) > 0,
        );
        if (onExch) continue; // всё ОК, позиция реально открыта на бирже

        try {
          const price = await this.binanceClient.getPrice(pos.symbol);
          const closed = await store.close(pos.id, {
            exitPrice: price,
            exitReason: "RECONCILE_STARTUP",
          });
          const pnl = closed?.pnl ?? 0;
          const sign = pnl >= 0 ? "+" : "";
          console.log(
            `🔧 [${name}] Startup reconcile: closed orphan DB position ${pos.symbol} ${pos.side} | exit=${price} | PnL ${sign}$${pnl.toFixed(2)}`,
          );
          if (this.telegram) {
            await this.telegram
              .send(
                `🔧 *${name}* startup reconcile\n` +
                  `${pos.symbol} ${pos.side} был OPEN в БД, но не найден на бирже.\n` +
                  `Закрыл в БД по текущей цене ${price}. PnL ${sign}$${pnl.toFixed(2)}`,
              )
              .catch(() => {});
          }
        } catch (err) {
          console.error(
            `❌ [${name}] Startup reconcile close failed for ${pos.symbol}: ${err.message}`,
          );
        }
      }
    }

    // Направление 2: биржа OPEN, но в БД нет (ни в одной стратегии)
    const allDbSymbols = new Set();
    for (const { store } of this.stores) {
      try {
        const dbOpen = await store.getOpenPositions();
        dbOpen.forEach((p) => allDbSymbols.add(p.symbol));
      } catch (err) {
        /* ignored, обработано выше */
      }
    }

    for (const exch of exchangePositions) {
      if (allDbSymbols.has(exch.symbol)) continue;
      const msg =
        `⚠️ Orphan on exchange at startup\n` +
        `${exch.symbol} ${exch.side} amt=${exch.positionAmt} entry=${exch.entryPrice}\n` +
        `В БД этой позиции нет — SL/TP не настроены.\n` +
        `**Manual review required.**`;
      console.error(
        `⚠️  Orphan on exchange: ${exch.symbol} ${exch.side} amt=${exch.positionAmt} entry=${exch.entryPrice} — SL/TP not tracked`,
      );
      if (this.telegram) {
        await this.telegram.send(msg).catch(() => {});
      }
    }

    console.log(`🔧 PositionMonitor: startup reconcile done\n`);
  }

  async _tick() {
    if (this._running) return;
    this._running = true;

    try {
      for (const { store, name } of this.stores) {
        const positions = await store.getOpenPositions();
        if (!positions.length) continue;

        for (const pos of positions) {
          await this._checkPosition(pos, store, name);
        }
      }
    } catch (err) {
      console.error(`❌ PositionMonitor tick error: ${err.message}`);
    } finally {
      this._running = false;
    }
  }

  async _checkPosition(pos, store, strategyName) {
    try {
      // [GAP #1] Reconcile-first: если позиции на бирже уже нет,
      // закрываем в БД и выходим. Защита от бесконечного цикла
      // "close → -2022 ReduceOnly rejected" после неудачной верификации.
      //
      // Также используем этот же вызов getPositions() как источник
      // правды дальше — второй вызов в блоке верификации не нужен.
      let exchangePositions;
      try {
        exchangePositions = await this.binanceClient.getPositions();
      } catch (err) {
        // Не смогли получить состояние биржи — лучше ничего не делать
        // на этом тике, чем стрелять вслепую. Попробуем на следующем.
        console.warn(
          `⚠️  [${strategyName}] getPositions() failed: ${err.message}. Skip tick for ${pos.symbol}.`,
        );
        return;
      }

      const onExchange = exchangePositions.find(
        (p) => p.symbol === pos.symbol && Math.abs(p.positionAmt) > 0,
      );

      if (!onExchange) {
        // Позиция в БД OPEN, на бирже — нет. Скорее всего предыдущий
        // close-ордер отработал, но верификация на прошлом tick не
        // успела это увидеть (eventual consistency Binance).
        const price = await this._getPrice(pos.symbol);
        const closed = await store.close(pos.id, {
          exitPrice: price,
          exitReason: "RECONCILE",
        });
        const pnl = closed?.pnl ?? 0;
        const sign = pnl >= 0 ? "+" : "";
        console.log(
          `🔧 [${strategyName}] ${pos.symbol} отсутствует на бирже — закрыта в БД (reconcile). PnL: ${sign}$${pnl.toFixed(2)}`,
        );
        if (this.telegram) {
          await this.telegram
            .send(
              `🔧 *${strategyName}* reconcile\n` +
                `${pos.symbol} ${pos.side} закрыт на бирже, синхронизировал БД.\n` +
                `Exit: ${price} | PnL: ${sign}$${pnl.toFixed(2)}`,
            )
            .catch(() => {});
        }
        return;
      }

      // Позиция реально есть на бирже — проверяем SL/TP
      const price = await this._getPrice(pos.symbol);
      const { side, stopLoss, takeProfit, positionSize, symbol } = pos;

      let triggered = null;

      if (side === "LONG") {
        if (price <= stopLoss) {
          triggered = { reason: "SL", exitPrice: price, emoji: "🔴" };
        } else if (price >= takeProfit) {
          triggered = { reason: "TP", exitPrice: price, emoji: "🟢" };
        }
      } else if (side === "SHORT") {
        if (price >= stopLoss) {
          triggered = { reason: "SL", exitPrice: price, emoji: "🔴" };
        } else if (price <= takeProfit) {
          triggered = { reason: "TP", exitPrice: price, emoji: "🟢" };
        }
      }

      if (!triggered) return;

      console.log(
        `\n${triggered.emoji} [${strategyName}] ${triggered.reason} сработал!`,
      );
      console.log(
        `   ${symbol} ${side} | Цена: ${price} | SL: ${stopLoss} | TP: ${takeProfit}`,
      );

      const closeSide = side === "LONG" ? "SELL" : "BUY";

      try {
        // [GAP #3] closeMarketOrder гарантирует reduceOnly=true на уровне
        // метода — не может случайно перевернуть позицию в orphan.
        const order = await this.binanceClient.closeMarketOrder({
          symbol,
          side: closeSide,
          quantity: positionSize,
          clientOrderId: `${triggered.reason}_${Date.now()}`,
        });

        const filled = await this.binanceClient.waitForOrderFill(
          symbol,
          order.orderId,
          8000,
          300,
        );

        const exitPrice = parseFloat(filled.avgPrice) || triggered.exitPrice;

        // Верификация: реально ли позиция закрыта на бирже?
        // Если Binance ещё не успел обновить state — отпустим, следующий
        // tick зайдёт в reconcile-ветку выше и корректно закроет в БД.
        let positionStillOpen = false;
        try {
          await new Promise((r) => setTimeout(r, 400));
          const after = await this.binanceClient.getPositions();
          const stillOpen = after.find(
            (p) => p.symbol === symbol && Math.abs(p.positionAmt) > 0,
          );
          if (stillOpen) {
            positionStillOpen = true;
            console.error(
              `🚨 [${strategyName}] Позиция НЕ закрыта на бирже после reduce-only fill!`,
            );
            console.error(
              `   symbol=${symbol} positionAmt=${stillOpen.positionAmt} entryPrice=${stillOpen.entryPrice}`,
            );
          }
        } catch (verifyErr) {
          console.warn(
            `⚠️  [${strategyName}] getPositions() verify упал: ${verifyErr.message}. Trust the fill.`,
          );
        }

        if (positionStillOpen) {
          // НЕ закрываем в БД — следующий tick либо увидит позицию закрытой
          // (reconcile-ветка) либо снова триггернёт close.
          if (this.telegram) {
            await this.telegram
              .send(
                `🚨 *${strategyName}* close failed verification\n` +
                  `${symbol} ${side}\n` +
                  `Fill был OK, но getPositions() всё ещё видит позицию.\n` +
                  `Оставил в БД как OPEN, следующий tick разберётся.\n` +
                  `**Если не закроется в течение минуты — ручное вмешательство.**`,
              )
              .catch(() => {});
          }
          return;
        }

        const closed = await store.close(pos.id, {
          exitPrice,
          exitReason: triggered.reason,
        });

        const pnl = closed?.pnl ?? 0;
        const sign = pnl >= 0 ? "+" : "";

        console.log(
          `✅ [${strategyName}] Позиция закрыта по ${triggered.reason}`,
        );
        console.log(`   Exit: ${exitPrice} | PnL: ${sign}$${pnl.toFixed(2)}`);

        if (this.telegram) {
          await this.telegram
            .send(
              `${triggered.emoji} *${strategyName}* ${triggered.reason} сработал\n` +
                `${symbol} ${side}\n` +
                `Entry: ${pos.entry} → Exit: ${exitPrice}\n` +
                `PnL: ${sign}$${pnl.toFixed(2)}`,
            )
            .catch(() => {});
        }
      } catch (closeErr) {
        // Особый случай: -2022 ReduceOnly rejected означает, что позиции
        // уже нет на бирже. Это не ошибка — это гонка. Следующий tick
        // попадёт в reconcile-ветку и корректно закроет в БД.
        const msg = closeErr.message || "";
        const isReduceOnlyReject =
          msg.includes("-2022") ||
          msg.toLowerCase().includes("reduceonly") ||
          msg.toLowerCase().includes("reduce only");

        if (isReduceOnlyReject) {
          console.log(
            `ℹ️  [${strategyName}] close rejected as reduceOnly — позиции уже нет на бирже. Reconcile на следующем tick.`,
          );
          return;
        }

        console.error(
          `❌ [${strategyName}] Не удалось закрыть позицию: ${closeErr.message}`,
        );
        console.error(
          `   ПОЗИЦИЯ ОСТАЁТСЯ ОТКРЫТОЙ — требуется ручное вмешательство!`,
        );
        if (this.telegram) {
          await this.telegram
            .send(
              `❌ *${strategyName}* close order FAILED\n` +
                `${symbol} ${side}\n` +
                `Error: ${closeErr.message}\n` +
                `Позиция на бирже открыта, SL/TP НЕ обрабатывается. Ручной разбор.`,
            )
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error(`❌ PositionMonitor checkPosition error: ${err.message}`);
    }
  }
}
