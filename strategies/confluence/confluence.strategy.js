import { BaseStrategy } from "../BaseStrategy.js";
import { confluenceConfig } from "./.config.js";
import {
  SIGNAL_TYPES,
  createHoldSignal,
  createTradeSignal,
} from "../../core/signal/signal.types.js";
import { ConfluenceGate } from "./ConfluenceGate.js";
import { ConfluenceFeatureBuilder } from "./ConfluenceFeatureBuilder.js";

/**
 * ConfluenceStrategy — мульти-факторная rule-based стратегия с ML size modifier.
 *
 * АРХИТЕКТУРА:
 *   1. FeatureBuilder.build(context) → features object
 *   2. ConfluenceGate.check(features) → { passed, direction, score, results }
 *   3. Если passed:
 *      a. ML predict (только BTCUSDT) → confidence
 *      b. Size modifier: multiplier ∈ [1.0, 2.0] от confidence (если ML согласен с Gate)
 *      c. Размер = baselineSize × multiplier (>= min для символа)
 *      d. SL/TP от ATR
 *      e. Возврат TradeSignal с meta.fixedSize
 *   4. Если НЕ passed:
 *      Возврат HoldSignal с деталями (какие правила не прошли)
 *
 * ─────────────────────────────────────────────────────────────────────
 * ML LOGIC — ВАЖНОЕ ОСОБОЕ ПРАВИЛО:
 *
 *   ML может только УВЕЛИЧИВАТЬ размер, не отменять трейд.
 *   Если Gate говорит "LONG", а ML говорит "SELL" — мы всё равно открываем
 *   long (Gate выше по приоритету), но multiplier = 1.0 (baseline размер).
 *
 *   Это defensive ML: модель защищает от слабых сетапов через размер,
 *   но не блокирует rule-based решения.
 *
 *   Применяется ТОЛЬКО на BTCUSDT (модель обучена только на BTC).
 *   Для остальных символов multiplier всегда = 1.0.
 * ─────────────────────────────────────────────────────────────────────
 */
export class ConfluenceStrategy extends BaseStrategy {
  constructor({ mlClient = null, configOverrides = {} } = {}) {
    const effectiveConfig = {
      ...confluenceConfig,
      ...configOverrides,
      rules: { ...confluenceConfig.rules, ...(configOverrides.rules ?? {}) },
    };

    super({
      id: confluenceConfig.id,
      name: confluenceConfig.name,
      config: effectiveConfig,
    });

    // ML опционален. Если null — multiplier всегда 1.0.
    this.mlClient = mlClient;

    // Pre-instantiate Gate (он pure, можно один раз)
    this.gate = new ConfluenceGate(effectiveConfig);
  }

  shouldRun(context) {
    const c1h = context.candles?.["1h"] ?? [];
    return c1h.length >= this.config.minCandles1h;
  }

  /**
   * Применять ли ML на этом символе?
   */
  _shouldUseMl(symbol) {
    return (
      this.mlClient !== null && this.config.ml.enabledSymbols.includes(symbol)
    );
  }

  /**
   * Линейная интерполяция confidence → multiplier.
   * При confidence = minConfidence → multiplier = 1.0
   * При confidence = 1.0           → multiplier = maxMultiplier
   * Между ними — линейно.
   */
  _confidenceToMultiplier(confidence) {
    const { minConfidence, maxMultiplier } = this.config.ml;
    if (confidence <= minConfidence) return 1.0;
    if (confidence >= 1.0) return maxMultiplier;
    const t = (confidence - minConfidence) / (1.0 - minConfidence);
    return 1.0 + t * (maxMultiplier - 1.0);
  }

  /**
   * Получить ML multiplier с защитой от ошибок.
   * Возвращает { multiplier, mlSignal, mlConfidence, reason }
   */
  async _getMlMultiplier(context, gateDirection) {
    const symbol = context.symbol;

    if (!this._shouldUseMl(symbol)) {
      return {
        multiplier: 1.0,
        mlSignal: null,
        mlConfidence: null,
        reason: "ml_disabled_for_symbol",
      };
    }

    try {
      const ml = await this.mlClient.predict({
        candles1h: (context.candles?.["1h"] ?? []).slice(-250),
        candles4h: (context.candles?.["4h"] ?? []).slice(-100),
        candles1d: (context.candles?.["1d"] ?? []).slice(-100),
      });

      if (!ml) {
        return {
          multiplier: 1.0,
          mlSignal: null,
          mlConfidence: null,
          reason: "ml_unavailable",
        };
      }

      // ML согласен с Gate?
      // Gate=LONG требует ML.signal=BUY
      // Gate=SHORT требует ML.signal=SELL
      const expected = gateDirection === "LONG" ? "BUY" : "SELL";
      const agrees = ml.signal === expected;

      if (!agrees) {
        return {
          multiplier: 1.0,
          mlSignal: ml.signal,
          mlConfidence: ml.confidence,
          reason: `ml_disagree (ml=${ml.signal}, gate=${gateDirection})`,
        };
      }

      const multiplier = this._confidenceToMultiplier(ml.confidence);
      return {
        multiplier,
        mlSignal: ml.signal,
        mlConfidence: ml.confidence,
        reason: `ml_agree (${ml.signal} @ ${(ml.confidence * 100).toFixed(0)}%, mul=${multiplier.toFixed(2)}x)`,
      };
    } catch (err) {
      console.warn(`⚠️  Confluence ML error: ${err.message}`);
      return {
        multiplier: 1.0,
        mlSignal: null,
        mlConfidence: null,
        reason: "ml_error",
      };
    }
  }

  /**
   * Рассчитать финальный размер позиции с учётом ML multiplier.
   * Возвращает null если символ не сконфигурирован.
   */
  _computePositionSize(symbol, multiplier) {
    const sizeConfig = this.config.positionSize[symbol];
    if (!sizeConfig) return null;

    const sized = sizeConfig.baseline * multiplier;
    // Минимум — это hard floor от Binance lot size, ниже не торгуем
    return Math.max(sizeConfig.min, sized);
  }

  /**
   * Главный метод — генерация сигнала.
   */
  async generateSignal(context) {
    const symbol = context.symbol;

    // ── 1. Build features ────────────────────────────────────
    const fb = ConfluenceFeatureBuilder.build(context);
    if (!fb.valid) {
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `features_invalid: ${fb.reason}`,
      });
    }
    const features = fb.features;

    // ── 2. Gate check ────────────────────────────────────────
    const gateResult = this.gate.check(features);

    // Логируем компактную сводку всех признаков
    const summary = ConfluenceFeatureBuilder.formatSummary(features);

    if (!gateResult.passed) {
      const failedNames = gateResult.results
        .filter((r) => !r.passed)
        .map((r) => r.name)
        .join(", ");
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `gate_failed ${gateResult.score}/${gateResult.total} (closest: ${gateResult.bestSide}) — failed: ${failedNames}`,
        meta: {
          summary,
          gateScore: gateResult.score,
          gateTotal: gateResult.total,
          gateBestSide: gateResult.bestSide,
          gateResults: gateResult.results,
        },
      });
    }

    // ── 3. Gate passed — определяем направление ──────────────
    const direction = gateResult.direction; // "LONG" | "SHORT"
    const tradeType =
      direction === "LONG" ? SIGNAL_TYPES.BUY : SIGNAL_TYPES.SELL;

    // ── 4. ML multiplier ─────────────────────────────────────
    const mlResult = await this._getMlMultiplier(context, direction);

    // ── 5. Position size ─────────────────────────────────────
    const positionSize = this._computePositionSize(symbol, mlResult.multiplier);
    if (positionSize === null) {
      return createHoldSignal({
        strategyId: this.id,
        strategyName: this.name,
        symbol,
        reason: `no_size_config_for_${symbol}`,
        meta: { summary, gateScore: gateResult.score },
      });
    }

    // ── 6. SL/TP через ATR ───────────────────────────────────
    const atr = features.atr_1h;
    const slOffset = atr * this.config.slMultiplier;
    const tpOffset = atr * this.config.tpMultiplier;

    const entry = features.price;
    let stopLoss, takeProfit;
    if (direction === "LONG") {
      stopLoss = entry - slOffset;
      takeProfit = entry + tpOffset;
    } else {
      stopLoss = entry + slOffset;
      takeProfit = entry - tpOffset;
    }

    // ── 7. Confidence: gate score / total ────────────────────
    // Это "уверенность" в сигнале для SignalAggregator.
    // Полный pass = 1.0; для confluence так и есть, потому что gate
    // требует все 8 правил, иначе не passed.
    const confidence = gateResult.score / gateResult.total;

    // ── 8. Создание trade signal ─────────────────────────────
    const reason =
      `Confluence ${direction} ${gateResult.score}/${gateResult.total} | ` +
      `${mlResult.reason} | ` +
      `size=${positionSize}`;

    const signal = createTradeSignal({
      strategyId: this.id,
      strategyName: this.name,
      symbol,
      type: tradeType,
      entry,
      stopLoss,
      takeProfit,
      confidence,
      reason,
      meta: {
        // Для лога
        summary,
        gateScore: gateResult.score,
        gateTotal: gateResult.total,
        gateResults: gateResult.results,
        direction,

        // ML контекст
        mlSignal: mlResult.mlSignal,
        mlConfidence: mlResult.mlConfidence,
        mlMultiplier: mlResult.multiplier,
        mlReason: mlResult.reason,

        // ВАЖНО: fixedSize — RiskManager использует это как
        // готовый positionSize, не пересчитывая через риск-формулу.
        fixedSize: positionSize,

        // ATR для пересчёта SL/TP в ExecutionService после fill (FIX #1)
        atr,
      },
    });

    // Дополнительно — поля slOffset/tpOffset на верхнем уровне
    // (ExecutionService ищет именно их, не в meta).
    return {
      ...signal,
      slOffset,
      tpOffset,
      // Дублируем mlSignal/mlConfidence на верхнем уровне для совместимости
      // с MongoPositionStore.open() который читает их оттуда.
      mlSignal: mlResult.mlSignal ?? "HOLD",
      mlConfidence: mlResult.mlConfidence ?? 0,
    };
  }

  /**
   * Профиль риска. Используется TradingEngine для leverage и SL/TP мульт.
   */
  getRiskProfile() {
    return {
      leverage: this.config.leverage,
      slMultiplier: this.config.slMultiplier,
      tpMultiplier: this.config.tpMultiplier,
      maxHoldHours: this.config.maxHoldHours,
    };
  }
}
