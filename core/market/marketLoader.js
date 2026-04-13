/**
 * MarketLoader — собирает полную картину рынка для одного символа.
 *
 * Это инфраструктурный слой между провайдерами и ContextBuilder.
 *
 * MarketLoader НЕ знает про стратегии и НЕ знает про ML.
 * Его задача — собрать всё что описывает РЫНОК:
 *   - свечи
 *   - индикаторы
 *   - режим
 *   - тренд старшего таймфрейма
 *   - объёмное соотношение
 *   - балансы
 *   - открытые позиции
 *
 * Получает все провайдеры через DI (конструктор).
 * Это значит — для тестов можно подменить реальные провайдеры на mock,
 * для бэктеста — на исторические, для live — на боевые.
 *
 * Стратегии этого даже не заметят.
 */
export class MarketLoader {
  constructor({
    candleProvider,
    indicatorProvider,
    accountProvider,
    positionProvider,
    regimeProvider,
    config = {},
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

    this.candleProvider = candleProvider;
    this.indicatorProvider = indicatorProvider;
    this.accountProvider = accountProvider;
    this.positionProvider = positionProvider;
    this.regimeProvider = regimeProvider;

    // Конфиг — сколько свечей фетчить для каждого таймфрейма
    this.config = {
      candleLimits: {
        "15m": 300,
        "1h": 300,
        "4h": 200,
        "1d": 100,
      },
      ...config,
    };
  }

  /**
   * Загрузить всё что нужно для одного символа.
   *
   * @param {string} symbol - например "BTCUSDT"
   * @returns {Object} market data
   */
  async load(symbol) {
    if (!symbol) throw new Error("MarketLoader.load: symbol required");

    // ── 1. Свечи всех таймфреймов параллельно ────────────────────
    const [candles15m, candles1h, candles4h, candles1d] = await Promise.all([
      this.candleProvider.getCandles(
        symbol,
        "15m",
        this.config.candleLimits["15m"],
      ),
      this.candleProvider.getCandles(
        symbol,
        "1h",
        this.config.candleLimits["1h"],
      ),
      this.candleProvider.getCandles(
        symbol,
        "4h",
        this.config.candleLimits["4h"],
      ),
      this.candleProvider.getCandles(
        symbol,
        "1d",
        this.config.candleLimits["1d"],
      ),
    ]);

    // Текущая цена = close последней 1h свечи
    const price = candles1h.at(-1)?.close ?? null;

    // ── 2. Индикаторы ────────────────────────────────────────────
    const indicators = await this.indicatorProvider.build({
      "15m": candles15m,
      "1h": candles1h,
      "4h": candles4h,
      "1d": candles1d,
    });

    // ── 3. Режим рынка и HTF тренд ──────────────────────────────
    const [marketRegime, htfTrend, volumeRatio] = await Promise.all([
      this.regimeProvider.getMarketRegime(candles1h),
      this.regimeProvider.getHTFTrend(candles4h),
      this.regimeProvider.getVolumeRatio(candles1h),
    ]);

    // ── 4. Балансы и позиции ─────────────────────────────────────
    const [balances, openPositions] = await Promise.all([
      this.accountProvider.getBalances(),
      this.positionProvider.getOpenPositions(symbol),
    ]);

    // ── 5. Финальная структура market data ──────────────────────
    return {
      candles: {
        "15m": candles15m,
        "1h": candles1h,
        "4h": candles4h,
        "1d": candles1d,
      },
      price,
      indicators,
      marketRegime,
      htfTrend,
      volumeRatio,
      balances,
      positions: {
        open: openPositions,
        hasOpenPosition: openPositions.length > 0,
      },
    };
  }
}
