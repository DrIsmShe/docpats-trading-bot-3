import { BaseStrategy } from "../BaseStrategy.js";
import { breakoutConfig } from "./.config.js";
import {
  SIGNAL_TYPES,
  createHoldSignal,
  createTradeSignal,
} from "../../core/signal/signal.types.js";

/**
 * Breakout Strategy — финальная рабочая версия (baseline).
 *
 * Логика: ловим пробои high20/low20 на 1h таймфрейме с подтверждением:
 *   - тренд (EMA20 vs EMA50)
 *   - сильная свеча (тело > 50%)
 *   - RSI в зоне силы
 *   - объём подтверждает (volRatio > 1.3)
 *   - моментум (3 свечи подряд)
 *   - волатильность (ATR > 0.18%)
 *
 * Walk-forward результат на 5 окнах × 17 дней:
 *   - 2/5 прибыльных окон
 *   - Total PnL: +$31.61
 *   - Avg PF: 1.42
 *   - Max DD: 2.4%
 */
export class BreakoutStrategy extends BaseStrategy {
  constructor() {
    super({
      id: breakoutConfig.id,
      name: breakoutConfig.name,
      config: breakoutConfig,
    });
  }

  shouldRun(context) {
    const candles = context.candles?.["1h"] ?? [];
    return candles.length >= this.config.minCandles;
  }

  generateSignal(context) {
    const symbol = context.symbol;
    const candles = context.candles?.["1h"] ?? [];

    if (candles.length < this.config.minCandles) {
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `Not enough candles (${candles.length}/${this.config.minCandles})`,
      });
    }

    // ── Индикаторы ─────────────────────────────────────────────
    const indicators = context.indicators?.["1h"] ?? {};
    const ema20Arr = indicators.ema20 ?? [];
    const ema50Arr = indicators.ema50 ?? [];
    const atrArr = indicators.atr ?? [];
    const rsiArr = indicators.rsi ?? [];

    const lastEMA20 = ema20Arr.at(-1);
    const lastEMA50 = ema50Arr.at(-1);
    const lastATR = atrArr.at(-1);
    const lastRSI = rsiArr.at(-1);

    const last = candles.at(-1);
    const prev = candles.at(-2);
    const prev2 = candles.at(-3);

    if (
      !last ||
      !prev ||
      !prev2 ||
      lastEMA20 == null ||
      lastEMA50 == null ||
      lastATR == null ||
      lastRSI == null
    ) {
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: "Indicators not ready",
      });
    }

    const price = last.close;
    const atrPercent = (lastATR / price) * 100;

    // ── Фильтр волатильности ────────────────────────────────────
    if (atrPercent < this.config.minVolatilityPct) {
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `Low volatility (ATR ${atrPercent.toFixed(2)}%)`,
        meta: { atrPercent },
      });
    }

    // ── High/Low за 20 свечей ───────────────────────────────────
    const closes = candles.map((c) => c.close);
    const lookback = closes.slice(-21, -1);
    const high20 = Math.max(...lookback);
    const low20 = Math.min(...lookback);

    // ── Объём ──────────────────────────────────────────────────
    const volumes = candles.slice(-20).map((c) => c.volume);
    const avgVol =
      volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const volRatio = avgVol > 0 ? last.volume / avgVol : 0;

    // ── Свечной анализ ─────────────────────────────────────────
    const range = last.high - last.low || 1;
    const body = Math.abs(last.close - last.open);
    const bodyRatio = body / range;
    const bullish = last.close > last.open && bodyRatio > 0.5;
    const bearish = last.close < last.open && bodyRatio > 0.5;

    const upMom = last.close > prev.close && prev.close > prev2.close;
    const downMom = last.close < prev.close && prev.close < prev2.close;

    const uptrend = lastEMA20 > lastEMA50;
    const downtrend = lastEMA20 < lastEMA50;

    // ═══════════════════════════════════════════════════════════
    // 🟢 LONG: пробой high20 + все подтверждения
    // ═══════════════════════════════════════════════════════════
    if (
      price > high20 &&
      uptrend &&
      bullish &&
      lastRSI > 52 &&
      lastRSI < 75 &&
      volRatio > this.config.minVolumeRatio &&
      upMom
    ) {
      const slMul = this.config.slMultiplier ?? 1.5;
      const tpMul = this.config.tpMultiplier ?? 3.5;
      // [FIX #1] Абсолютные смещения — для пересчёта SL/TP в ExecutionService
      // от РЕАЛЬНОЙ цены исполнения (avgPrice), а не от signal.entry.
      const slOffset = lastATR * slMul;
      const tpOffset = lastATR * tpMul;
      const sig = createTradeSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        type: SIGNAL_TYPES.BUY,
        entry: price,
        stopLoss: price - slOffset,
        takeProfit: price + tpOffset,
        confidence: 0.72,
        reason: `Breakout up vol:${volRatio.toFixed(2)}x rsi:${lastRSI.toFixed(0)}`,
        meta: { volRatio, atrPercent, high20 },
      });
      // Расширяем результат createTradeSignal полями, которых helper может не знать
      return { ...sig, slOffset, tpOffset };
    }

    // ═══════════════════════════════════════════════════════════
    // 🔴 SHORT: пробой low20 + все подтверждения
    // ═══════════════════════════════════════════════════════════
    if (
      price < low20 &&
      downtrend &&
      bearish &&
      lastRSI < 48 &&
      lastRSI > 25 &&
      volRatio > this.config.minVolumeRatio &&
      downMom
    ) {
      const slMul = this.config.slMultiplier ?? 1.5;
      const tpMul = this.config.tpMultiplier ?? 3.5;
      const slOffset = lastATR * slMul;
      const tpOffset = lastATR * tpMul;
      const sig = createTradeSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        type: SIGNAL_TYPES.SELL,
        entry: price,
        stopLoss: price + slOffset,
        takeProfit: price - tpOffset,
        confidence: 0.72,
        reason: `Breakout down vol:${volRatio.toFixed(2)}x rsi:${lastRSI.toFixed(0)}`,
        meta: { volRatio, atrPercent, low20 },
      });
      return { ...sig, slOffset, tpOffset };
    }

    return createHoldSignal({
      strategyId: this.id,
      strategyName: this.name,
      symbol,
      reason: "No breakout setup",
    });
  }
}
