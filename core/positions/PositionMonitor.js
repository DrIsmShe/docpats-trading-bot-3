/**
 * PositionMonitor — программный мониторинг SL/TP.
 *
 * Binance запрещает STOP_MARKET ордера через /fapi/v1/order (-4120),
 * поэтому SL/TP реализован программно:
 *   - Каждые N секунд запрашивает текущую цену
 *   - Сравнивает с SL/TP из MongoDB
 *   - При достижении — закрывает MARKET ордером
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

      // Закрываем MARKET ордером
      const closeSide = side === "LONG" ? "SELL" : "BUY";

      try {
        const order = await this.binanceClient.placeMarketOrder({
          symbol,
          side: closeSide,
          quantity: positionSize,
          clientOrderId: `${triggered.reason}_${Date.now()}`,
        });

        // Ждём fill
        const filled = await this.binanceClient.waitForOrderFill(
          symbol,
          order.orderId,
          8000,
          300,
        );

        const exitPrice = parseFloat(filled.avgPrice) || triggered.exitPrice;

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
      }
    } catch (err) {
      console.error(`❌ PositionMonitor checkPosition error: ${err.message}`);
    }
  }
}
