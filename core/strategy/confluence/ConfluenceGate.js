/**
 * ConfluenceGate — rule-based gate для Confluence стратегии.
 *
 * Это PURE FUNCTION класс — никакого state, никаких побочных эффектов,
 * никаких сетевых вызовов. Принимает features, возвращает решение.
 *
 * Это намеренно: pure functions легко тестируются unit-тестами,
 * не требуют моков, не зависят от внешних систем.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ВХОД (features) — структура объекта:
 * {
 *   price: 95.28,
 *   ema200_4h: 95.14,
 *   ema20_1h: 95.10, ema50_1h: 94.80, ema200_1h: 94.50,
 *   oiChangePct: 1.6,       // % за 1h
 *   takerRatio: 1.099,
 *   topLsDelta: 0.03,       // изменение L/S умных денег за 1h
 *   crowdLs: 1.37,
 *   fundingPct: 0.005,      // в процентах (не дробью)
 *   change24hPct: 0.63,     // изменение цены за 24h в процентах
 * }
 *
 * ВЫХОД:
 * {
 *   passed: true|false,           // прошло ли ВСЕ правила
 *   direction: "LONG"|"SHORT"|null, // если passed=true, в какую сторону
 *   score: 0-8,                   // сколько правил прошло (для лога)
 *   results: [                    // детализация каждого правила
 *     { name, passed, value, threshold }
 *   ],
 * }
 * ─────────────────────────────────────────────────────────────────────
 */
export class ConfluenceGate {
  constructor(config) {
    if (!config) throw new Error("ConfluenceGate: config required");
    this.config = config;
    this.rules = config.rules;
  }

  /**
   * Главный метод — проверяет features и возвращает решение.
   *
   * Логика:
   *   1. Проверяем LONG-сторону (все 8 правил).
   *   2. Если LONG прошёл — возвращаем direction=LONG.
   *   3. Иначе проверяем SHORT-сторону.
   *   4. Если SHORT прошёл — возвращаем direction=SHORT.
   *   5. Иначе возвращаем лучший score (для логирования "почему не прошло").
   */
  check(features) {
    const long = this.checkLong(features);
    if (long.passed) return long;

    const short = this.checkShort(features);
    if (short.passed) return short;

    // Ни одна сторона не прошла — возвращаем лучший score для лога
    const better = long.score >= short.score ? long : short;
    return {
      passed: false,
      direction: null,
      score: better.score,
      total: better.total,
      results: better.results,
      bestSide: better.direction, // какая сторона была ближе к прохождению
    };
  }

  /**
   * Проверка LONG entry.
   */
  checkLong(features) {
    const results = [];

    // ── Правило 1: price > EMA200_4h ─────────────────────────
    if (this.rules.enablePriceVsEma200) {
      const passed = features.price > features.ema200_4h;
      results.push({
        name: "price_above_ema200_4h",
        passed,
        value: features.price,
        threshold: features.ema200_4h,
        detail: `${features.price?.toFixed(4)} > ${features.ema200_4h?.toFixed(4)}`,
      });
    }

    // ── Правило 2: EMA20 > EMA50 > EMA200 на 1h ──────────────
    if (this.rules.enableTrendStructure) {
      const e20 = features.ema20_1h;
      const e50 = features.ema50_1h;
      const e200 = features.ema200_1h;
      const passed = e20 > e50 && e50 > e200;
      results.push({
        name: "trend_structure_bullish",
        passed,
        value: { e20, e50, e200 },
        detail: `EMA20=${e20?.toFixed(2)} EMA50=${e50?.toFixed(2)} EMA200=${e200?.toFixed(2)}`,
      });
    }

    // ── Правило 3: OI растёт (> minOiChangePct) ──────────────
    {
      const passed = features.oiChangePct > this.rules.minOiChangePct;
      results.push({
        name: "oi_rising",
        passed,
        value: features.oiChangePct,
        threshold: this.rules.minOiChangePct,
        detail: `OI Δ ${features.oiChangePct?.toFixed(2)}% > ${this.rules.minOiChangePct}%`,
      });
    }

    // ── Правило 4: taker buy/sell > 1.0 (покупатели агрессивнее) ──
    {
      const passed = features.takerRatio > this.rules.minTakerRatioLong;
      results.push({
        name: "taker_buy_dominant",
        passed,
        value: features.takerRatio,
        threshold: this.rules.minTakerRatioLong,
        detail: `taker ${features.takerRatio?.toFixed(3)} > ${this.rules.minTakerRatioLong}`,
      });
    }

    // ── Правило 5: smart money не уменьшают позицию (delta >= 0) ──
    if (this.rules.requireSmartMoneyDirection) {
      const passed = features.topLsDelta >= 0;
      results.push({
        name: "smart_money_holding_or_buying",
        passed,
        value: features.topLsDelta,
        threshold: 0,
        detail: `topLS Δ ${features.topLsDelta?.toFixed(3)} >= 0`,
      });
    }

    // ── Правило 6: толпа не в эйфории (crowdLS < maxCrowdLsLong) ──
    {
      const passed = features.crowdLs < this.rules.maxCrowdLsLong;
      results.push({
        name: "crowd_not_euphoric",
        passed,
        value: features.crowdLs,
        threshold: this.rules.maxCrowdLsLong,
        detail: `crowdLS ${features.crowdLs?.toFixed(2)} < ${this.rules.maxCrowdLsLong}`,
      });
    }

    // ── Правило 7: funding не в премии за лонг ───────────────
    {
      const passed = features.fundingPct < this.rules.maxFundingPctLong;
      results.push({
        name: "funding_not_premium_long",
        passed,
        value: features.fundingPct,
        threshold: this.rules.maxFundingPctLong,
        detail: `funding ${features.fundingPct?.toFixed(4)}% < ${this.rules.maxFundingPctLong}%`,
      });
    }

    // ── Правило 8: не parabolic move ──────────────────────────
    {
      const passed =
        Math.abs(features.change24hPct) < this.rules.maxAbsChange24hPct;
      results.push({
        name: "not_parabolic",
        passed,
        value: features.change24hPct,
        threshold: this.rules.maxAbsChange24hPct,
        detail: `|24h Δ| ${Math.abs(features.change24hPct ?? 0).toFixed(2)}% < ${this.rules.maxAbsChange24hPct}%`,
      });
    }

    const score = results.filter((r) => r.passed).length;
    const passed = score === results.length;

    return {
      passed,
      direction: "LONG",
      score,
      total: results.length,
      results,
    };
  }

  /**
   * Проверка SHORT entry (зеркально к LONG).
   */
  checkShort(features) {
    const results = [];

    // ── Правило 1: price < EMA200_4h ─────────────────────────
    if (this.rules.enablePriceVsEma200) {
      const passed = features.price < features.ema200_4h;
      results.push({
        name: "price_below_ema200_4h",
        passed,
        value: features.price,
        threshold: features.ema200_4h,
        detail: `${features.price?.toFixed(4)} < ${features.ema200_4h?.toFixed(4)}`,
      });
    }

    // ── Правило 2: EMA20 < EMA50 < EMA200 на 1h ──────────────
    if (this.rules.enableTrendStructure) {
      const e20 = features.ema20_1h;
      const e50 = features.ema50_1h;
      const e200 = features.ema200_1h;
      const passed = e20 < e50 && e50 < e200;
      results.push({
        name: "trend_structure_bearish",
        passed,
        value: { e20, e50, e200 },
        detail: `EMA20=${e20?.toFixed(2)} EMA50=${e50?.toFixed(2)} EMA200=${e200?.toFixed(2)}`,
      });
    }

    // ── Правило 3: OI растёт (новые шорты открываются) ───────
    // ВАЖНО: для SHORT мы тоже требуем OI > minOiChangePct.
    // OI растёт при падающей цене (через taker_sell) = новые шорты,
    // что подтверждает медвежий контекст.
    {
      const passed = features.oiChangePct > this.rules.minOiChangePct;
      results.push({
        name: "oi_rising",
        passed,
        value: features.oiChangePct,
        threshold: this.rules.minOiChangePct,
        detail: `OI Δ ${features.oiChangePct?.toFixed(2)}% > ${this.rules.minOiChangePct}%`,
      });
    }

    // ── Правило 4: taker sell dominant (зеркально) ───────────
    // takerRatio < 1/minTakerRatioLong = 0.91 при пороге 1.10 для лонга
    {
      const threshold = 1 / this.rules.minTakerRatioLong;
      const passed = features.takerRatio < threshold;
      results.push({
        name: "taker_sell_dominant",
        passed,
        value: features.takerRatio,
        threshold,
        detail: `taker ${features.takerRatio?.toFixed(3)} < ${threshold.toFixed(3)}`,
      });
    }

    // ── Правило 5: smart money не наращивают лонг (delta <= 0) ──
    if (this.rules.requireSmartMoneyDirection) {
      const passed = features.topLsDelta <= 0;
      results.push({
        name: "smart_money_holding_or_selling",
        passed,
        value: features.topLsDelta,
        threshold: 0,
        detail: `topLS Δ ${features.topLsDelta?.toFixed(3)} <= 0`,
      });
    }

    // ── Правило 6: толпа не в панике (crowdLS > 1/maxCrowdLsLong) ──
    // зеркально: если для лонга порог 1.8, то для шорта мин 1/1.8 = 0.55
    {
      const threshold = 1 / this.rules.maxCrowdLsLong;
      const passed = features.crowdLs > threshold;
      results.push({
        name: "crowd_not_panicked",
        passed,
        value: features.crowdLs,
        threshold,
        detail: `crowdLS ${features.crowdLs?.toFixed(2)} > ${threshold.toFixed(2)}`,
      });
    }

    // ── Правило 7: funding не в дисконте за шорт ─────────────
    // зеркально: для лонга порог +0.01%, для шорта -0.01%
    {
      const threshold = -this.rules.maxFundingPctLong;
      const passed = features.fundingPct > threshold;
      results.push({
        name: "funding_not_premium_short",
        passed,
        value: features.fundingPct,
        threshold,
        detail: `funding ${features.fundingPct?.toFixed(4)}% > ${threshold}%`,
      });
    }

    // ── Правило 8: не parabolic move (то же что для лонга) ───
    {
      const passed =
        Math.abs(features.change24hPct) < this.rules.maxAbsChange24hPct;
      results.push({
        name: "not_parabolic",
        passed,
        value: features.change24hPct,
        threshold: this.rules.maxAbsChange24hPct,
        detail: `|24h Δ| ${Math.abs(features.change24hPct ?? 0).toFixed(2)}% < ${this.rules.maxAbsChange24hPct}%`,
      });
    }

    const score = results.filter((r) => r.passed).length;
    const passed = score === results.length;

    return {
      passed,
      direction: "SHORT",
      score,
      total: results.length,
      results,
    };
  }

  /**
   * Утилита: красиво отформатировать результаты для лога.
   * Возвращает многострочную строку с эмодзи статусами.
   */
  formatResults(gateResult) {
    if (!gateResult || !gateResult.results) return "no results";
    const lines = gateResult.results.map((r) => {
      const emoji = r.passed ? "✅" : "❌";
      return `   ${emoji} ${r.name}: ${r.detail}`;
    });
    const header = gateResult.passed
      ? `✅ PASSED (${gateResult.direction}) ${gateResult.score}/${gateResult.total}`
      : `❌ FAILED ${gateResult.score}/${gateResult.total} (closest: ${gateResult.bestSide ?? "?"})`;
    return [header, ...lines].join("\n");
  }
}
