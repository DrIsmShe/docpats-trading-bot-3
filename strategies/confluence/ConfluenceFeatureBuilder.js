/**
 * ConfluenceFeatureBuilder — собирает features object из context.
 *
 * Это адаптер между общим MarketLoader/ContextBuilder контекстом и
 * конкретным форматом, который ожидает ConfluenceGate.
 *
 * Стратегий может быть несколько, у каждой свой FeatureBuilder
 * (как у каждой Java DAO своя сущность). Это позволяет менять формат
 * features без изменения провайдеров и Gate-а.
 *
 * Также здесь — валидация: если какие-то критические метрики null
 * (например, derivatives endpoint упал), мы возвращаем { valid: false,
 * reason } и стратегия пропустит цикл с понятным логом, а не упадёт
 * на TypeError позже.
 */
export class ConfluenceFeatureBuilder {
  /**
   * Построить features из context.
   *
   * @returns {Object}
   *   { valid: true, features: {...} }  — все данные на месте, можно в Gate
   *   { valid: false, reason: string }  — каких-то данных нет, HOLD
   */
  static build(context) {
    const symbol = context.symbol;

    // ── 1. EMA индикаторы ────────────────────────────────────
    const ind1h = context.indicators?.["1h"];
    const ind4h = context.indicators?.["4h"];

    if (!ind1h || !ind4h) {
      return { valid: false, reason: "indicators_not_ready" };
    }

    const ema20_1h = ind1h.ema20?.at(-1);
    const ema50_1h = ind1h.ema50?.at(-1);
    const ema200_1h = ind1h.ema200?.at(-1);
    const ema200_4h = ind4h.ema200?.at(-1);
    const atr_1h = ind1h.atr?.at(-1);

    if (
      ema20_1h == null ||
      ema50_1h == null ||
      ema200_1h == null ||
      ema200_4h == null ||
      atr_1h == null ||
      atr_1h <= 0
    ) {
      return { valid: false, reason: "ema_or_atr_null" };
    }

    // ── 2. Деривативы ────────────────────────────────────────
    const deriv = context.derivatives;
    if (!deriv) {
      return { valid: false, reason: "derivatives_missing" };
    }

    if (!deriv.topLS) return { valid: false, reason: "topLS_missing" };
    if (!deriv.crowdLS) return { valid: false, reason: "crowdLS_missing" };
    if (!deriv.taker) return { valid: false, reason: "taker_missing" };
    if (!deriv.openInterest)
      return { valid: false, reason: "openInterest_missing" };

    // ── 3. Funding ───────────────────────────────────────────
    const funding = context.marketContext?.funding;
    if (!funding) {
      return { valid: false, reason: "funding_missing" };
    }

    // ── 4. Price ─────────────────────────────────────────────
    const price = context.price;
    if (!price || price <= 0) {
      return { valid: false, reason: "no_price" };
    }

    // ── 5. Все данные на месте, собираем features ────────────
    const features = {
      symbol,
      price,
      atr_1h, // для расчёта SL/TP в strategy

      // EMA
      ema20_1h,
      ema50_1h,
      ema200_1h,
      ema200_4h,

      // Деривативы
      oiChangePct: deriv.openInterest.deltaPct,
      takerRatio: deriv.taker.current,
      takerDelta: deriv.taker.delta,
      topLs: deriv.topLS.current,
      topLsDelta: deriv.topLS.delta,
      crowdLs: deriv.crowdLS.current,
      crowdLsDelta: deriv.crowdLS.delta,

      // Funding (в процентах, не дробью!)
      fundingPct: funding.ratePct,

      // Изменение цены за 24h
      change24hPct: context.change24hPct ?? 0,
    };

    return { valid: true, features };
  }

  /**
   * Утилита: красивый одно-строчный лог по features (для cycle output).
   */
  static formatSummary(features) {
    if (!features) return "no features";
    return (
      `price=${features.price?.toFixed(4)} ` +
      `OI ${features.oiChangePct?.toFixed(2)}% ` +
      `taker=${features.takerRatio?.toFixed(3)} ` +
      `topLS=${features.topLs?.toFixed(2)} (Δ${features.topLsDelta >= 0 ? "+" : ""}${features.topLsDelta?.toFixed(3)}) ` +
      `crowdLS=${features.crowdLs?.toFixed(2)} ` +
      `funding=${features.fundingPct?.toFixed(4)}% ` +
      `24h=${features.change24hPct >= 0 ? "+" : ""}${features.change24hPct?.toFixed(2)}%`
    );
  }
}
