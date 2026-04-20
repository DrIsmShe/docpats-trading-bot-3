import { BaseStrategy } from "../BaseStrategy.js";

/**
 * ML-Only Strategy — торгует ТОЛЬКО на основе предсказаний ML модели,
 * с мягкими контекстными фильтрами.
 *
 * Параметры:
 *   minConfidence       — базовый минимум ML confidence (0.55)
 *   atrMultiplierSL     — SL = entry ± ATR × этот множитель (1.5)
 *   atrMultiplierTP     — TP = entry ± ATR × этот множитель (3.0, R/R 1:2)
 *   maxHoldCandles      — max время удержания (24 свечи 1h)
 *   fundingThresholdPct — "сильный" funding в процентах (0.05 = ±0.05%)
 *   contraFundingBoost  — надбавка к confidence если сигнал ПРОТИВ funding (0.10 = +10%)
 *   riskyHourBoost      — надбавка в "опасные" часы (0.10 = +10%)
 *
 * Фильтры работают как МЯГКИЕ: они повышают требуемый порог confidence,
 * но не блокируют сигнал полностью. Это позволяет сильным сигналам
 * проходить даже при неблагоприятном funding/времени суток.
 */
export class MLOnlyStrategy extends BaseStrategy {
  constructor({
    mlClient,
    minConfidence = 0.55,
    atrMultiplierSL = 1.5,
    atrMultiplierTP = 3.0,
    maxHoldCandles = 24,
    fundingThresholdPct = 0.05, // ±0.05% = "сильный" funding
    contraFundingBoost = 0.1, // +10% к порогу если сигнал contra
    riskyHourBoost = 0.1, // +10% к порогу в опасные часы
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
        fundingThresholdPct,
        contraFundingBoost,
        riskyHourBoost,
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
    this.fundingThresholdPct = fundingThresholdPct;
    this.contraFundingBoost = contraFundingBoost;
    this.riskyHourBoost = riskyHourBoost;
  }

  shouldRun(context) {
    const candles = context.candles?.["1h"] ?? [];
    return candles.length >= this.config.minCandles;
  }

  /**
   * Рассчитать эффективный порог confidence на основе рыночного контекста.
   * Возвращает { threshold, reasons[] } — список применённых надбавок для лога.
   */
  _computeEffectiveThreshold(signalDirection, marketContext) {
    let threshold = this.minConfidence;
    const reasons = [];

    const funding = marketContext?.funding;
    const time = marketContext?.time;

    // ── Funding filter ──────────────────────────────────────────
    // Если funding сильно ПРОТИВ нашего сигнала — повышаем порог.
    // Контр-funding для BUY = сильно положительный (лонгов много, платят)
    // Контр-funding для SELL = сильно отрицательный (шортов много, платят)
    if (funding && typeof funding.ratePct === "number") {
      const thr = this.fundingThresholdPct;
      if (signalDirection === "BUY" && funding.ratePct > thr) {
        threshold += this.contraFundingBoost;
        reasons.push(
          `contra_funding (${funding.ratePct.toFixed(3)}% > +${thr}%)`,
        );
      } else if (signalDirection === "SELL" && funding.ratePct < -thr) {
        threshold += this.contraFundingBoost;
        reasons.push(
          `contra_funding (${funding.ratePct.toFixed(3)}% < -${thr}%)`,
        );
      }
    }

    // ── Risky hour filter ───────────────────────────────────────
    if (time?.isRiskyHour) {
      threshold += this.riskyHourBoost;
      reasons.push(`risky_hour (${time.reason})`);
    }

    return { threshold, reasons };
  }

  async generateSignal(context) {
    const symbol = context.symbol;
    const candles1h = context.candles?.["1h"] ?? [];
    const candles4h = context.candles?.["4h"] ?? [];
    const candles1d = context.candles?.["1d"] ?? [];
    const indicators1h = context.indicators?.["1h"] ?? {};
    const marketContext = context.marketContext ?? {};

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

    // Рассчитать эффективный порог с учётом funding/time
    const { threshold, reasons } = this._computeEffectiveThreshold(
      signal,
      marketContext,
    );
    const boostLabel =
      reasons.length > 0 ? ` [+boost: ${reasons.join(", ")}]` : "";

    if (confidence < threshold) {
      return {
        type: "HOLD",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `low_confidence ${(confidence * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%${boostLabel}`,
      };
    }

    // SL/TP offsets — фикс #1 (пересчёт от avgPrice в ExecutionService)
    const slOffset = atr * this.atrMultiplierSL;
    const tpOffset = atr * this.atrMultiplierTP;

    // Логируем "просочившийся через усиленный порог" сигнал явно
    const reasonSuffix = boostLabel ? ` (passed${boostLabel})` : "";

    if (signal === "BUY") {
      return {
        type: "BUY",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        entry: last.close,
        stopLoss: last.close - slOffset,
        takeProfit: last.close + tpOffset,
        slOffset,
        tpOffset,
        confidence,
        mlSignal: signal,
        mlConfidence: confidence,
        reason: `ML BUY ${(confidence * 100).toFixed(0)}% ${probsTxt}${reasonSuffix}`,
      };
    }

    if (signal === "SELL") {
      return {
        type: "SELL",
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        entry: last.close,
        stopLoss: last.close + slOffset,
        takeProfit: last.close - tpOffset,
        slOffset,
        tpOffset,
        confidence,
        mlSignal: signal,
        mlConfidence: confidence,
        reason: `ML SELL ${(confidence * 100).toFixed(0)}% ${probsTxt}${reasonSuffix}`,
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
