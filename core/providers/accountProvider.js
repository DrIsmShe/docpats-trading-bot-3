/**
 * AccountProvider — даёт информацию о балансах счёта.
 *
 * РЕЖИМЫ:
 *   - mock:    возвращает фиксированные значения (для тестов и dev)
 *   - live:    фетчит с боевого Binance Futures API через BinanceFuturesClient
 *   - testnet: фетчит с Binance testnet (через BinanceFuturesClient с testnet=true)
 *
 * ВАЖНО: интерфейс `getBalances()` остаётся таким же независимо от режима.
 * Когда мы меняем mock → live, стратегии и MarketLoader не замечают разницы.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   const accountProvider = new AccountProvider({
 *     mode: "live",
 *     binanceClient: binanceFuturesClient,
 *   });
 *   const balances = await accountProvider.getBalances();
 *   // → { spot: 143.45, futures: 143.45 }
 */
export class AccountProvider {
  constructor({
    mode = "mock",
    mockBalance = 1000,
    binanceClient = null,
    cacheTtlMs = 10_000,
  } = {}) {
    this.mode = mode;
    this.mockBalance = mockBalance;
    this.binanceClient = binanceClient;
    this.cacheTtlMs = cacheTtlMs;

    // Простой кеш — Binance балансы меняются медленно, не нужно дёргать API на каждый цикл
    this._cache = null;
    this._cacheAt = 0;

    if ((mode === "live" || mode === "testnet") && !binanceClient) {
      throw new Error(
        `AccountProvider mode "${mode}" requires binanceClient (instance of BinanceFuturesClient)`,
      );
    }
  }

  /**
   * Получить балансы счёта.
   *
   * @returns {Promise<{spot: number, futures: number, available: number}>}
   *   - spot: общий баланс кошелька в USDT (для фьючерсного аккаунта)
   *   - futures: то же что spot (для совместимости со старым кодом)
   *   - available: доступная маржа для новых позиций (после вычета занятой)
   */
  async getBalances() {
    if (this.mode === "mock") {
      return {
        spot: this.mockBalance,
        futures: this.mockBalance,
        available: this.mockBalance,
      };
    }

    if (this.mode === "live" || this.mode === "testnet") {
      // Используем кеш чтобы не дёргать Binance на каждый цикл
      const now = Date.now();
      if (this._cache && now - this._cacheAt < this.cacheTtlMs) {
        return this._cache;
      }

      try {
        const balance = await this.binanceClient.getBalance();
        const result = {
          spot: balance.totalWalletBalance,
          futures: balance.totalWalletBalance,
          available: balance.availableBalance,
        };
        this._cache = result;
        this._cacheAt = now;
        return result;
      } catch (err) {
        console.error(
          `❌ AccountProvider: failed to fetch balance from Binance: ${err.message}`,
        );
        // Если есть устаревший кеш — вернём его (лучше чем ничего)
        if (this._cache) {
          console.warn("⚠️  Returning stale cached balance");
          return this._cache;
        }
        throw err;
      }
    }

    throw new Error(`AccountProvider: unknown mode "${this.mode}"`);
  }

  /**
   * Принудительно сбросить кеш (например, после открытия/закрытия позиции).
   */
  invalidateCache() {
    this._cache = null;
    this._cacheAt = 0;
  }
}
