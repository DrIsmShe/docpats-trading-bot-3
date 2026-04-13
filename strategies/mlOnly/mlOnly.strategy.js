import { BaseStrategy } from "../BaseStrategy.js";

/**
 * ML-Only Strategy — торгует ТОЛЬКО на основе предсказаний ML модели.
 *
 * Параметры:
 *   minConfidence    — минимальная уверенность ML для входа (0.45)
 *   atrMultiplierSL  — SL = entry ± ATR × этот множитель (1.5)
 *   atrMultiplierTP  — TP = entry ± ATR × этот множитель (3.0, R/R 1:2)
 *   maxHoldCandles   — max время удержания (24 свечи 1h)
 */
export class MLOnlyStrategy extends BaseStrategy {
  constructor({
    mlClient,
    minConfidence = 0.45,
    atrMultiplierSL = 1.5,
    atrMultiplierTP = 3.0,
    maxHoldCandles = 24,
  } = {}) {
    super({
      id: "mlOnly",
      name: "ML-Only",
      config: {
        minConfidence,
        atrMultiplierSL,
        atrMultiplierTP,
        maxHoldCandles,
        minCandles: 250,
      },
    });

    if (!mlClient) {
      throw new Error("MLOnlyStrategy requires mlClient");
    }
    this.mlClient = mlClient;
    this.minConfidence = minConfidence;
    this.atrMultiplierSL = atrMultiplierSL;
    this.atrMultiplierTP = atrMultiplierTP;
    this.maxHoldCandles = maxHoldCandles;
  }

  shouldRun(context) {
    const candles = context.candles?.["1h"] ?? [];
    return candles.length >= this.config.minCandles;
  }

  async generateSignal(context) {
    const symbol = context.symbol;
    const candles1h = context.candles?.["1h"] ?? [];
    const candles4h = context.candles?.["4h"] ?? [];
    const candles1d = context.candles?.["1d"] ?? [];
    const indicators1h = context.indicators?.["1h"] ?? {};

    if (candles1h.length < 250) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `not_enough_1h (${candles1h.length}/250)`,
      };
    }
    if (candles4h.length < 50 || candles1d.length < 50) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `not_enough_4h_or_1d`,
      };
    }

    const last = candles1h.at(-1);
    const atr = indicators1h?.atr?.at(-1);

    if (!atr || atr <= 0) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: "no_atr",
      };
    }

    const ml = await this.mlClient.predict({
      candles1h: candles1h.slice(-250),
      candles4h: candles4h.slice(-100),
      candles1d: candles1d.slice(-100),
    });

    if (!ml) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: "ml_unavailable",
      };
    }

    const { signal, confidence, buy, hold, sell } = ml;
    const probsTxt = `B:${(buy * 100).toFixed(0)}% H:${(hold * 100).toFixed(0)}% S:${(sell * 100).toFixed(0)}%`;

    if (signal === "HOLD") {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `ml_hold ${probsTxt}`,
      };
    }

    if (confidence < this.minConfidence) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `low_confidence ${(confidence * 100).toFixed(0)}% < ${(this.minConfidence * 100).toFixed(0)}%`,
      };
    }

    if (signal === "BUY") {
      return {
        type: "BUY",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        entry: last.close,
        stopLoss: last.close - atr * this.atrMultiplierSL,
        takeProfit: last.close + atr * this.atrMultiplierTP,
        confidence,
        reason: `ML BUY ${(confidence * 100).toFixed(0)}% ${probsTxt}`,
      };
    }

    if (signal === "SELL") {
      return {
        type: "SELL",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        entry: last.close,
        stopLoss: last.close + atr * this.atrMultiplierSL,
        takeProfit: last.close - atr * this.atrMultiplierTP,
        confidence,
        reason: `ML SELL ${(confidence * 100).toFixed(0)}% ${probsTxt}`,
      };
    }

    return {
      type: "HOLD",
      strategyId: this.id,
      strategyName: this.name,
      symbol,
      reason: "unknown_signal",
    };
  }
}
