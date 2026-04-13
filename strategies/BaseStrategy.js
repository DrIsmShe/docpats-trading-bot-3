/**
 * Базовый класс для всех стратегий.
 *
 * Каждая стратегия должна:
 *   1. Унаследоваться от BaseStrategy
 *   2. Передать в super() свои id, name, config
 *   3. Реализовать generateSignal(context)
 *   4. (опционально) переопределить shouldRun(context) для оптимизации
 *   5. (опционально) переопределить getRiskProfile() для своих SL/TP/leverage
 *
 * StrategyManager работает со стратегиями через этот единый интерфейс.
 */
export class BaseStrategy {
  constructor({ id, name, config = {} }) {
    if (!id) throw new Error("BaseStrategy: id is required");
    if (!name) throw new Error("BaseStrategy: name is required");

    this.id = id;
    this.name = name;
    this.config = config;
  }

  /**
   * Должна ли стратегия запускаться в этом цикле?
   * Возвращает false если данных недостаточно или стратегия выключена.
   * Используется как быстрый отсев перед тяжёлым generateSignal.
   */
  shouldRun(_context) {
    return true;
  }

  /**
   * Главный метод — анализирует контекст и возвращает сигнал.
   * ОБЯЗАТЕЛЬНО переопределить в наследнике.
   *
   * Должен вернуть объект формата { type, entry, stopLoss, takeProfit, confidence, reason, meta }
   * Для удобства используй createHoldSignal / createTradeSignal из signal.types.js
   */
  generateSignal(_context) {
    throw new Error(`${this.name}: generateSignal() not implemented`);
  }

  /**
   * Профиль риска для этой стратегии.
   * RiskManager использует эти значения при расчёте размера позиции.
   *
   * Дефолт — консервативный. Стратегии могут переопределить.
   */
  getRiskProfile() {
    return {
      leverage: this.config.leverage ?? 1,
      slMultiplier: this.config.slMultiplier ?? 1.5,
      tpMultiplier: this.config.tpMultiplier ?? 3.0,
      maxHoldHours: this.config.maxHoldHours ?? 24,
    };
  }
}
