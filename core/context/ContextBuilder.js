/**
 * ContextBuilder — собирает финальный контекст для одного цикла торговли.
 *
 * Это тонкая обёртка над MarketLoader, которая:
 *   - Добавляет к рыночным данным ML предсказание (если ML включён)
 *   - Прикрепляет ссылку на список стратегий (нужно RiskManager-у)
 *   - Стандартизирует структуру context
 *
 * Стратегии, RiskManager и ExecutionService работают с этим контекстом.
 */
export class ContextBuilder {
  constructor({ marketLoader, mlClient = null, strategies = [] }) {
    if (!marketLoader) throw new Error("ContextBuilder: marketLoader required");

    this.marketLoader = marketLoader;
    this.mlClient = mlClient;
    this.strategies = strategies;
  }

  async build({ symbol }) {
    // ── 1. Загружаем рыночные данные ────────────────────────────
    const market = await this.marketLoader.load(symbol);

    // ── 2. Запрашиваем ML предсказание (опционально) ────────────
    let ml = {
      enabled: false,
      signal: "HOLD",
      confidence: 0,
      raw: null,
    };

    if (this.mlClient) {
      try {
        const mlResult = await this.mlClient.predict({
          symbol,
          candles15m: market.candles?.["15m"] ?? [],
          candles1h: market.candles?.["1h"] ?? [],
          candles4h: market.candles?.["4h"] ?? [],
          candles1d: market.candles?.["1d"] ?? [],
        });

        ml = {
          enabled: true,
          signal: mlResult?.signal ?? "HOLD",
          confidence: mlResult?.confidence ?? 0,
          raw: mlResult ?? null,
        };
      } catch (err) {
        console.error("⚠️  ML build error:", err.message);
        // Не падаем — система работает без ML
      }
    }

    // ── 3. Финальный контекст ───────────────────────────────────
    return {
      symbol,
      timestamp: new Date().toISOString(),

      // Рыночные данные
      candles: market.candles ?? {},
      price: market.price ?? null,
      indicators: market.indicators ?? {},
      marketRegime: market.marketRegime ?? "UNKNOWN",
      htfTrend: market.htfTrend ?? "UNKNOWN",
      volumeRatio: market.volumeRatio ?? 0,

      // Мета-рыночные данные (funding, open interest, time-of-day)
      // Структура: { funding: {rate, ratePct, nextFundingTime, markPrice}|null,
      //              openInterest: {currentOI, previousOI, deltaPct, trend}|null,
      //              time: {utcHour, utcDayOfWeek, isWeekend, isWeekendNight, isRiskyHour, reason} }
      marketContext: market.marketContext ?? {
        funding: null,
        openInterest: null,
        time: {
          utcHour: new Date().getUTCHours(),
          utcDayOfWeek: new Date().getUTCDay(),
          isWeekend: false,
          isWeekendNight: false,
          isRiskyHour: false,
          reason: null,
        },
      },

      // Счёт
      balances: market.balances ?? { spot: 0, futures: 0 },
      positions: market.positions ?? { open: [], hasOpenPosition: false },

      // ML
      ml,

      // Ссылка на список стратегий (RiskManager использует для getRiskProfile)
      strategies: this.strategies,
    };
  }
}
