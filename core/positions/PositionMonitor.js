/**
 * PositionMonitor — мониторинг открытых позиций в paper mode.
 *
 * Логика:
 *   1. Берём все открытые позиции
 *   2. Для каждой смотрим последнюю свечу 1m или 5m или 1h (что есть)
 *   3. Если high >= TP (для LONG) или low <= TP (для SHORT) — закрываем по TP
 *   4. Если low <= SL (для LONG) или high >= SL (для SHORT) — закрываем по SL
 *   5. Если ни то ни другое — позиция остаётся открытой
 *
 * В Phase 2 заменим на реальный мониторинг через Binance WebSocket / API.
 */
export class PositionMonitor {
  constructor({ candleProvider, positionStore, executionService }) {
    if (!candleProvider)
      throw new Error("PositionMonitor: candleProvider required");
    if (!positionStore)
      throw new Error("PositionMonitor: positionStore required");
    if (!executionService)
      throw new Error("PositionMonitor: executionService required");

    this.candleProvider = candleProvider;
    this.positionStore = positionStore;
    this.executionService = executionService;
  }

  /**
   * Проверить все открытые позиции.
   * Возвращает массив закрытых позиций (если были).
   */
  async checkAll(symbol) {
    const open = this.positionStore.getOpen(symbol);
    if (open.length === 0) return [];

    // Берём последнюю свечу 1h как прокси для текущей цены
    // (в Phase 2 заменим на 1m или live ticker)
    const lastCandle = await this.candleProvider.getLastCandle(symbol, "1h");
    if (!lastCandle) return [];

    const closed = [];

    for (const pos of open) {
      const result = this._checkPosition(pos, lastCandle);
      if (result) {
        const closedPos = await this.executionService.closePaper(
          pos.id,
          result,
        );
        if (closedPos) closed.push(closedPos);
      }
    }

    return closed;
  }

  /**
   * Проверить одну позицию.
   * Возвращает { exitPrice, exitReason } если позицию надо закрыть, иначе null.
   */
  _checkPosition(pos, candle) {
    const { high, low } = candle;

    if (pos.side === "LONG") {
      // Проверяем оба уровня. Пессимистичная логика: если оба сработали в одной свече —
      // считаем что сначала был SL (худший случай).
      const hitSL = low <= pos.stopLoss;
      const hitTP = high >= pos.takeProfit;

      if (hitSL) return { exitPrice: pos.stopLoss, exitReason: "SL" };
      if (hitTP) return { exitPrice: pos.takeProfit, exitReason: "TP" };
    } else {
      // SHORT
      const hitSL = high >= pos.stopLoss;
      const hitTP = low <= pos.takeProfit;

      if (hitSL) return { exitPrice: pos.stopLoss, exitReason: "SL" };
      if (hitTP) return { exitPrice: pos.takeProfit, exitReason: "TP" };
    }

    return null;
  }
}
