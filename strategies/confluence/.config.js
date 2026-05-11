/**
 * Confluence Strategy Config.
 *
 * Все пороги и параметры стратегии в одном месте.
 * Можно переопределять через .env (см. server.js).
 *
 * ─────────────────────────────────────────────────────────────────────
 * ФИЛОСОФИЯ ПОРОГОВ:
 *
 * Эти 8 правил — это hard gate. Если хотя бы одно НЕ выполнено — трейд
 * не открывается, никаких "мягких фильтров с boost'ом" как было в
 * Breakout. Мы хотим МАЛО трейдов ВЫСОКОГО качества, не наоборот.
 *
 * Начальные пороги намеренно строгие. Цель — 2-5 сигналов в неделю
 * на символ. Если за неделю будет 0 — ослабляем. Если 50 — ужесточаем.
 * ─────────────────────────────────────────────────────────────────────
 */
export const confluenceConfig = {
  id: "confluence",
  name: "Confluence",
  enabled: true,

  // Минимальное количество свечей для расчёта индикаторов
  minCandles1h: 250,
  minCandles4h: 50,
  minCandles1d: 30,

  // ─── Rule-based gate thresholds ──────────────────────────────
  // Все пороги одинаковы для LONG и SHORT (зеркально применяются)
  rules: {
    // Правило 1: цена относительно EMA200 на 4h
    //   LONG  → price > EMA200_4h (выше институционального уровня)
    //   SHORT → price < EMA200_4h
    enablePriceVsEma200: true,

    // Правило 2: trend structure на 1h
    //   LONG  → EMA20 > EMA50 > EMA200 (выстроены вверх)
    //   SHORT → EMA20 < EMA50 < EMA200 (выстроены вниз)
    enableTrendStructure: true,

    // Правило 3: open interest растёт
    //   LONG/SHORT → OI deltaPct > minOiChangePct
    //   (рост OI = новые позиции, контекст подсказывает направление)
    minOiChangePct: 0.5,

    // Правило 4: taker flow в направлении сделки
    //   LONG  → takerRatio > minTakerRatioLong (покупатели агрессивнее)
    //   SHORT → takerRatio < (1 / minTakerRatioLong) = 0.91 при 1.10 (зеркально)
    minTakerRatioLong: 1.0,

    // Правило 5: smart money L/S не уменьшается (для long) / не растёт (для short)
    //   LONG  → topLS.delta >= 0 (либо держат, либо добирают)
    //   SHORT → topLS.delta <= 0 (либо держат, либо распускают)
    //   Изначально мягко (>= 0), не требуем активного роста — это слишком редкое условие
    requireSmartMoneyDirection: true,

    // Правило 6: толпа не в эйфории / не в панике
    //   LONG  → crowdLS < maxCrowdLsLong (нет толпы в лонге уже)
    //   SHORT → crowdLS > minCrowdLsShort = 1/maxCrowdLsLong (зеркально)
    maxCrowdLsLong: 1.8,

    // Правило 7: funding не экстремальный (против направления сделки)
    //   LONG  → fundingPct < maxFundingPctLong (нет премии за лонг = нет эйфории)
    //   SHORT → fundingPct > -maxFundingPctLong (зеркально)
    //   0.01% за 8h ≈ 0.03%/day ≈ 11%/год — это уже заметная плата
    maxFundingPctLong: 0.01,

    // Правило 8: цена не в parabolic move
    //   |change24hPct| < maxAbsChange24hPct
    //   Защита от "FOMO на пике" и "паники на дне"
    maxAbsChange24hPct: 8,
  },

  // ─── Risk profile ────────────────────────────────────────────
  leverage: 10,
  slMultiplier: 1.5, // SL = entry ± ATR × 1.5
  tpMultiplier: 3.0, // TP = entry ± ATR × 3.0 (R:R 1:2)
  maxHoldHours: 36,

  // ─── ML size modifier ────────────────────────────────────────
  // ML модель используется ТОЛЬКО на BTC (на нём обучена)
  // Для других символов size modifier = 1.0 (фиксированный размер)
  ml: {
    enabledSymbols: ["BTCUSDT"],
    minConfidence: 0.55, // ниже = baseline размер (multiplier=1.0)
    maxMultiplier: 2.0, // максимум = 2x baseline при confidence=1.0
    // multiplier = 1.0 + (confidence - minConfidence) / (1.0 - minConfidence) × (maxMultiplier - 1.0)
    // При confidence=0.55 → 1.0x; при confidence=1.0 → 2.0x; линейно между
  },

  // ─── Position sizing (минимумы Binance + наш baseline) ───────
  // baseline — это размер при ML multiplier = 1.0 ИЛИ когда ML недоступен
  positionSize: {
    BTCUSDT: { min: 0.001, baseline: 0.002 }, // ~$200 notional при $100k
    ETHUSDT: { min: 0.01, baseline: 0.02 }, // ~$70 notional при $3500
    AVAXUSDT: { min: 0.1, baseline: 1.0 }, // ~$30 notional при $30
    LINKUSDT: { min: 0.1, baseline: 1.0 }, // ~$15 notional при $15
  },

  // ─── Cooldown after close ────────────────────────────────────
  // После закрытия позиции на символе — пауза перед следующим входом.
  // Защита от whipsaw серий (см. инцидент 19 апреля).
  cooldownAfterCloseMs: 15 * 60 * 1000, // 15 минут
};
