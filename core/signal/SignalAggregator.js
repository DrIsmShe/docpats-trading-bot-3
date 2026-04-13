import { SIGNAL_TYPES } from "./signal.types.js";

/**
 * Агрегатор сигналов.
 *
 * Получает массив сигналов от разных стратегий и решает,
 * какой выбрать для исполнения.
 *
 * Сейчас простая логика: выбрать торговый сигнал (BUY/SELL)
 * с самой высокой confidence.
 *
 * TODO в будущем:
 *   - majority vote
 *   - resolve conflicts (BUY vs SELL → SKIP)
 *   - regime-aware scoring
 *   - weighted vote по историческому PF стратегий
 */
export class SignalAggregator {
  constructor({ minConfidence = 0 } = {}) {
    this.minConfidence = minConfidence;
  }

  /**
   * Выбирает один сигнал из массива.
   * Возвращает null если нет торговых сигналов.
   */
  pick(signals = []) {
    if (!Array.isArray(signals) || signals.length === 0) {
      return null;
    }

    // Отсеять HOLD сигналы — они не торговые
    const active = signals.filter(
      (s) => s && s.type && s.type !== SIGNAL_TYPES.HOLD,
    );

    if (active.length === 0) {
      return null;
    }

    // Отсеять сигналы со слабой уверенностью
    const confident = active.filter(
      (s) => (s.confidence ?? 0) >= this.minConfidence,
    );

    if (confident.length === 0) {
      return null;
    }

    // Выбрать сигнал с самой высокой confidence
    const sorted = [...confident].sort(
      (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
    );

    return sorted[0];
  }
}
