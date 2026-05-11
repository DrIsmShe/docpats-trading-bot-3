/**
 * MarketLoader — собирает все рыночные данные одним методом load(symbol).
 *
 * Это единственная точка, которая знает обо ВСЕХ провайдерах:
 *   - CandleProvider (свечи из Mongo)
 *   - IndicatorProvider (EMA, RSI, ATR из свечей)
 *   - AccountProvider (баланс Binance)
 *   - PositionProvider (открытые позиции)
 *   - RegimeProvider (режим рынка + HTF trend)
 *   - MarketContextProvider (funding, OI базовый, time-of-day)
 *   - DerivativesProvider (top L/S, crowd L/S, taker, OI расширенный)
 *
 * Все запросы выполняются ПАРАЛЛЕЛЬНО через Promise.all, поэтому полная
 * загрузка одного символа занимает столько же времени, сколько самый
 * медленный запрос (обычно — Binance derivatives endpoints, ~200-400ms).
 *
 * ─────────────────────────────────────────────────────────────────────
 * ВОЗВРАЩАЕМАЯ СТРУКТУРА:
 *
 * {
 *   candles: { "1h": [...], "4h": [...], "1d": [...] },
 *   price: 95.28,
 *   change24hPct: 0.63,
 *   indicators: {
 *     "1h": { ema20, ema50, ema200, rsi, atr },
 *     "4h": { ema20, ema50, ema200, rsi, atr },
 *     "1d": { ema20, ema50, ema200, rsi, atr },
 *   },
 *   marketRegime: "UPTREND" | "DOWNTREND" | "SIDEWAYS",
 *   htfTrend: "UPTREND" | "DOWNTREND" | "SIDEWAYS",
 *   volumeRatio: 1.23,
 *   marketContext: {
 *     funding: { rate, ratePct, nextFundingTime, markPrice } | null,
 *     openInterest: { currentOI, previousOI, deltaPct, trend } | null,
 *     time: { utcHour, utcDayOfWeek, isWeekend, isWeekendNight, isRiskyHour, reason }
 *   },
 *   derivatives: {
 *     topLS: { current, previous, delta, longAccountPct } | null,
 *     crowdLS: { current, previous, delta } | null,
 *     taker: { current, previous, delta } | null,
 *     openInterest: { currentOI, previousOI, deltaPct, trend } | null,
 *   },
 *   balances: { spot, futures, available },
 *   positions: { open: [...], hasOpenPosition: bool },
 * }
 * ─────────────────────────────────────────────────────────────────────
 *
 * ВАЖНО: load() НЕ кидает исключения при ошибках отдельных провайдеров.
 * Если derivativesProvider упал — derivatives = null, стратегия это
 * увидит и решит сама (обычно — HOLD на этом цикле).
 *
 * Жёсткое требование: candles и price обязаны быть, иначе load() вернёт
 * null и цикл стратегии будет пропущен. Без свечей мы не можем считать
 * вообще ничего осмысленного.
 */
export class MarketLoader {
  constructor({
    candleProvider,
    indicatorProvider,
    accountProvider,
    positionProvider,
    regimeProvider,
    marketContextProvider,
    derivativesProvider, // NEW
    candleLimits = { "1h": 300, "4h": 100, "1d": 100 },
  }) {
    if (!candleProvider)
      throw new Error("MarketLoader: candleProvider required");
    if (!indicatorProvider)
      throw new Error("MarketLoader: indicatorProvider required");
    if (!accountProvider)
      throw new Error("MarketLoader: accountProvider required");
    if (!positionProvider)
      throw new Error("MarketLoader: positionProvider required");
    if (!regimeProvider)
      throw new Error("MarketLoader: regimeProvider required");
    if (!marketContextProvider)
      throw new Error("MarketLoader: marketContextProvider required");
    // derivativesProvider опционален — без него стратегии без деривативов могут работать

    this.candleProvider = candleProvider;
    this.indicatorProvider = indicatorProvider;
    this.accountProvider = accountProvider;
    this.positionProvider = positionProvider;
    this.regimeProvider = regimeProvider;
    this.marketContextProvider = marketContextProvider;
    this.derivativesProvider = derivativesProvider ?? null;
    this.candleLimits = candleLimits;
  }

  /**
   * Загрузить весь контекст рынка для одного символа.
   *
   * Возвращает null если критичные данные не получены (нет свечей 1h).
   */
  async load(symbol) {
    // ── 1. Загружаем свечи параллельно ─────────────────────────
    const [c1h, c4h, c1d] = await Promise.all([
      this.candleProvider.getCandles(symbol, "1h", this.candleLimits["1h"]),
      this.candleProvider.getCandles(symbol, "4h", this.candleLimits["4h"]),
      this.candleProvider.getCandles(symbol, "1d", this.candleLimits["1d"]),
    ]);

    // Критическая проверка — без 1h свечей вообще ничего не работает
    if (!Array.isArray(c1h) || c1h.length < 50) {
      console.warn(
        `⚠️  MarketLoader[${symbol}]: insufficient 1h candles (${c1h?.length ?? 0})`,
      );
      return null;
    }

    const candles = { "1h": c1h, "4h": c4h, "1d": c1d };
    const price = c1h.at(-1)?.close ?? null;

    if (!price) {
      console.warn(`⚠️  MarketLoader[${symbol}]: no price from last 1h candle`);
      return null;
    }

    // ── 2. change24hPct — изменение цены за 24 часа ────────────
    // Берём последнюю и -24-ую свечу 1h (24 часа назад)
    let change24hPct = 0;
    if (c1h.length >= 25) {
      const price24hAgo = c1h.at(-25)?.close;
      if (price24hAgo) {
        change24hPct = ((price - price24hAgo) / price24hAgo) * 100;
      }
    }

    // ── 3. Индикаторы (по всем ТФ) ──────────────────────────────
    const indicators = await this.indicatorProvider.build(candles);

    // ── 4. Остальное параллельно ────────────────────────────────
    const [
      balances,
      openPositions,
      marketRegime,
      htfTrend,
      volumeRatio,
      marketContext,
      derivatives,
    ] = await Promise.all([
      this.accountProvider.getBalances().catch((err) => {
        console.warn(`⚠️  MarketLoader[${symbol}] balances: ${err.message}`);
        return { spot: 0, futures: 0, available: 0 };
      }),
      this.positionProvider.getOpenPositions().catch((err) => {
        console.warn(`⚠️  MarketLoader[${symbol}] positions: ${err.message}`);
        return [];
      }),
      this.regimeProvider.getMarketRegime(c1h).catch(() => "UNKNOWN"),
      this.regimeProvider.getHTFTrend(c4h).catch(() => "UNKNOWN"),
      this.regimeProvider.getVolumeRatio(c1h).catch(() => 0),
      this.marketContextProvider.loadFull(symbol).catch((err) => {
        console.warn(
          `⚠️  MarketLoader[${symbol}] marketContext: ${err.message}`,
        );
        return {
          funding: null,
          openInterest: null,
          time: this.marketContextProvider.getTimeContext(),
        };
      }),
      this.derivativesProvider
        ? this.derivativesProvider.loadAll(symbol).catch((err) => {
            console.warn(
              `⚠️  MarketLoader[${symbol}] derivatives: ${err.message}`,
            );
            return {
              topLS: null,
              crowdLS: null,
              taker: null,
              openInterest: null,
            };
          })
        : Promise.resolve({
            topLS: null,
            crowdLS: null,
            taker: null,
            openInterest: null,
          }),
    ]);

    // ── 5. Открытые позиции для этого символа ───────────────────
    const symbolPositions = openPositions.filter((p) => p.symbol === symbol);

    return {
      symbol,
      timestamp: new Date().toISOString(),

      // Свечи и индикаторы
      candles,
      price,
      change24hPct,
      indicators,

      // Режим и тренд
      marketRegime,
      htfTrend,
      volumeRatio,

      // Контекст
      marketContext,
      derivatives, // ← новое поле

      // Счёт и позиции
      balances,
      positions: {
        open: symbolPositions,
        hasOpenPosition: symbolPositions.length > 0,
        allOpen: openPositions,
      },
    };
  }
}
