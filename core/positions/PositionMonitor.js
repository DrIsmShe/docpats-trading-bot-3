/**
 * PositionMonitor — программный мониторинг SL/TP.
 *
 * Binance запрещает STOP_MARKET ордера через /fapi/v1/order (-4120),
 * поэтому SL/TP реализован программно:
 *   - Каждые N секунд запрашивает текущую цену
 *   - Сравнивает с SL/TP из MongoDB
 *   - При достижении — закрывает MARKET ордером с reduceOnly=true
 *   - [FIX #4] После fill верифицирует через getPositions(), что позиция
 *     действительно закрылась на бирже. Если нет — оставляет запись OPEN,
 *     алертит в Telegram, повторит на следующем tick.
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

      // Закрываем MARKET ордером (с reduceOnly=true)
      const closeSide = side === "LONG" ? "SELL" : "BUY";

      try {
        // [FIX #4] reduceOnly=true гарантирует, что ордер не перевернёт позицию.
        // Без этого флага, если позиция уже (частично) закрыта по другой причине,
        // обычный market-ордер открыл бы обратную позицию (orphan).
        const order = await this.binanceClient.placeMarketOrder({
          symbol,
          side: closeSide,
          quantity: positionSize,
          clientOrderId: `${triggered.reason}_${Date.now()}`,
          reduceOnly: true,
        });

        // Ждём fill
        const filled = await this.binanceClient.waitForOrderFill(
          symbol,
          order.orderId,
          8000,
          300,
        );

        const exitPrice = parseFloat(filled.avgPrice) || triggered.exitPrice;

        // [FIX #4] Верификация через биржу: реально ли позиция закрыта?
        // Проверяем getPositions() и убеждаемся что positionAmt стал 0.
        // Если нет — оставляем запись OPEN, алерт, повторим на следующем tick.
        let positionStillOpen = false;
        try {
          // Небольшая задержка, чтобы Binance обновил состояние после fill
          await new Promise((r) => setTimeout(r, 400));
          const exchangePositions = await this.binanceClient.getPositions();
          const stillOpen = exchangePositions.find(
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
          // Верификация не удалась (сеть/API) — не блокируем close в БД,
          // но логируем warning. Fill уже подтверждён waitForOrderFill'ом.
          console.warn(
            `⚠️  [${strategyName}] getPositions() verify упал: ${verifyErr.message}. Trust the fill.`,
          );
        }

        if (positionStillOpen) {
          // НЕ закрываем в MongoDB — при следующем tick повторим попытку
          if (this.telegram) {
            await this.telegram
              .send(
                `🚨 *${strategyName}* close failed verification\n` +
                  `${symbol} ${side}\n` +
                  `Fill был OK, но getPositions() всё ещё видит позицию.\n` +
                  `Оставил в БД как OPEN, попробую снова на следующем tick.\n` +
                  `**Если не закроется — ручное вмешательство.**`,
              )
              .catch(() => {});
          }
          return;
        }

        // Закрываем позицию в MongoDB
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

        // Telegram уведомление (если подключён)
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
