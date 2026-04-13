/**
 * Менеджер стратегий.
 *
 * Получает массив стратегий через конструктор (DI),
 * запускает каждую на одном контексте, собирает сигналы.
 *
 * Ошибка одной стратегии НЕ ломает остальные —
 * каждая стратегия в своём try/catch.
 *
 * Это делает систему устойчивой: баг в новой стратегии
 * не убивает работающие.
 */
export class StrategyManager {
  constructor({ strategies = [] }) {
    if (!Array.isArray(strategies)) {
      throw new Error("StrategyManager: strategies must be an array");
    }
    this.strategies = strategies;
  }

  /**
   * Запускает все стратегии на данном контексте.
   * Возвращает массив сигналов от тех стратегий, которые отработали.
   */
  async run(context) {
    const signals = [];

    for (const strategy of this.strategies) {
      try {
        // Быстрый отсев — если стратегии нечего делать в этом контексте
        const canRun = strategy.shouldRun(context);
        if (!canRun) {
          continue;
        }

        // Главный вызов — стратегия анализирует и возвращает сигнал
        const signal = await strategy.generateSignal(context);
        if (!signal) continue;

        signals.push(signal);
      } catch (err) {
        // Ошибка одной стратегии не ломает остальные
        console.error(`❌ Strategy error [${strategy.name}]:`, err.message);
        if (process.env.NODE_ENV === "development") {
          console.error(err.stack);
        }
      }
    }

    return signals;
  }

  /**
   * Возвращает список зарегистрированных стратегий — для логов и дебага.
   */
  list() {
    return this.strategies.map((s) => ({ id: s.id, name: s.name }));
  }
}
