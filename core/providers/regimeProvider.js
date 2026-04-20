/**
 * RegimeProvider — определяет режим рынка и тренд старшего таймфрейма.
 *
 * Это РЕАЛЬНАЯ логика, не mock — она работает на свечах из Mongo.
 *
 * Используется:
 *   - StrategyManager: некоторые стратегии работают только в определённом режиме
 *   - SignalAggregator: режим может влиять на вес стратегий
 *   - Логи: показывает что происходит на рынке
 *
 * Режимы:
 *   UPTREND   — устойчивый рост (EMA20 > EMA50, цена выше EMA20)
 *   DOWNTREND — устойчивое падение (EMA20 < EMA50, цена ниже EMA20)
 *   SIDEWAYS  — флэт / неопределённость
 *
 * ПРИМЕЧАНИЕ: эвристика isRiskyHour / getTimeContext живёт в
 * MarketContextProvider, поскольку там же funding/OI. RegimeProvider
 * остаётся чисто про режим рынка на основе свечей.
 */
import { calcEMA } from "./indicators.calc.js";

export class RegimeProvider {
  /**
   * Определить режим рынка по свечам 1h.
   * Использует EMA20 и EMA50.
   */
  async getMarketRegime(candles1h) {
    if (!Array.isArray(candles1h) || candles1h.length < 50) {
      return "UNKNOWN";
    }

    const closes = candles1h.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);

    const lastEMA20 = ema20.at(-1);
    const lastEMA50 = ema50.at(-1);
    const lastClose = closes.at(-1);

    if (lastEMA20 == null || lastEMA50 == null) return "UNKNOWN";

    // Чёткий аптренд
    if (lastEMA20 > lastEMA50 && lastClose > lastEMA20) {
      return "UPTREND";
    }

    // Чёткий даунтренд
    if (lastEMA20 < lastEMA50 && lastClose < lastEMA20) {
      return "DOWNTREND";
    }

    // Всё остальное — неопределённость / флэт
    return "SIDEWAYS";
  }

  /**
   * Тренд старшего таймфрейма (4h).
   * Используется как фильтр направления для торговых стратегий.
   */
  async getHTFTrend(candles4h) {
    if (!Array.isArray(candles4h) || candles4h.length < 50) {
      return "UNKNOWN";
    }

    const closes = candles4h.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);

    const lastEMA20 = ema20.at(-1);
    const lastEMA50 = ema50.at(-1);

    if (lastEMA20 == null || lastEMA50 == null) return "UNKNOWN";

    if (lastEMA20 > lastEMA50) return "UPTREND";
    if (lastEMA20 < lastEMA50) return "DOWNTREND";
    return "SIDEWAYS";
  }

  /**
   * Дополнительная утилита: текущее volume ratio (последняя свеча vs среднее).
   * Может пригодиться SignalAggregator-у.
   */
  async getVolumeRatio(candles1h) {
    if (!Array.isArray(candles1h) || candles1h.length < 21) return 0;

    const last = candles1h.at(-1);
    const lookback = candles1h.slice(-21, -1);
    const avgVol =
      lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;

    return avgVol > 0 ? last.volume / avgVol : 0;
  }
}
