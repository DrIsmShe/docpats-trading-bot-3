import { calcEMA, calcRSI, calcATR } from "./indicators.calc.js";

/**
 * IndicatorProvider — рассчитывает индикаторы для нескольких таймфреймов.
 *
 * РАБОТАЕТ В РЕЖИМЕ EAGER: считает ВСЕ индикаторы для ВСЕХ таймфреймов
 * заранее, чтобы стратегии получали готовые массивы из контекста.
 *
 * Преимущества eager:
 *   - Стратегии не делают расчёты сами
 *   - Дублирование исключено (две стратегии на одном таймфрейме = один расчёт)
 *   - Контекст полностью самодостаточен
 *
 * Возвращает структуру:
 * {
 *   "15m": { ema20, ema50, ema200, rsi, atr },
 *   "1h":  { ema20, ema50, ema200, rsi, atr },
 *   "4h":  { ema20, ema50, ema200, rsi, atr },
 * }
 *
 * Каждое поле — МАССИВ той же длины что и свечи.
 * Стратегия достаёт последнее значение через .at(-1).
 */
export class IndicatorProvider {
  /**
   * Главный метод — принимает свечи по таймфреймам, возвращает индикаторы по таймфреймам.
   *
   * @param {Object} candlesByTF - { "15m": [...], "1h": [...], "4h": [...] }
   * @returns {Object}             - { "15m": {...indicators}, "1h": {...}, "4h": {...} }
   */
  async build(candlesByTF) {
    const result = {};

    for (const [timeframe, candles] of Object.entries(candlesByTF)) {
      result[timeframe] = this._calcForTimeframe(candles);
    }

    return result;
  }

  /**
   * Считает все индикаторы для одного массива свечей.
   * Возвращает { ema20, ema50, ema200, rsi, atr } — все массивы.
   */
  _calcForTimeframe(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return {
        ema20: [],
        ema50: [],
        ema200: [],
        rsi: [],
        atr: [],
      };
    }

    const closes = candles.map((c) => c.close);

    return {
      ema20: calcEMA(closes, 20),
      ema50: calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
      rsi: calcRSI(closes, 14),
      atr: calcATR(candles, 14),
    };
  }
}
