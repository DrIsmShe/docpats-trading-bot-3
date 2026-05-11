/**
 * DerivativesProvider — провайдер деривативных метрик с Binance Futures.
 *
 * Отделён от MarketContextProvider, потому что:
 *   - MarketContextProvider даёт мета-данные (funding, time-of-day, OI базовый)
 *   - DerivativesProvider даёт позиционные метрики L/S и flow + дельты между периодами
 *
 * Все endpoint'ы Binance ПУБЛИЧНЫЕ (без подписи), что упрощает интеграцию.
 *
 * ИСПОЛЬЗУЕМЫЕ ENDPOINTS:
 *   - /futures/data/openInterestHist        → OI history (limit=2 для дельты)
 *   - /futures/data/topLongShortPositionRatio → smart money L/S
 *   - /futures/data/globalLongShortAccountRatio → retail (crowd) L/S
 *   - /futures/data/takerlongshortRatio     → taker buy/sell flow
 *
 * ВАЖНО: все метрики запрашиваются с period=1h, limit=2. Это даёт нам:
 *   - current (последняя закрытая часовая точка)
 *   - prev (предыдущая часовая точка)
 *   - delta = current - prev  ← КЛЮЧЕВОЕ для confluence-логики
 *
 * Дельты переживают рестарт бота, потому что берутся напрямую с Binance,
 * а не из in-memory state. Никакого MongoDB кэша для метрик не нужно.
 *
 * RATE LIMITS:
 *   Каждый endpoint = 1 запрос. На один символ — 4 запроса.
 *   Для 4 символов = 16 запросов в минуту.
 *   Лимит Binance ~2400/мин — мы в 0.6% от лимита, абсолютно безопасно.
 *
 * Все методы best-effort: если Binance недоступен — возвращаем null,
 * стратегия корректно интерпретирует это как "нет данных" и пропустит цикл.
 */
export class DerivativesProvider {
  constructor({
    baseUrl = "https://fapi.binance.com",
    cacheTtlMs = 60_000, // 1 минута — period=1h меняется не чаще
    period = "1h",
  } = {}) {
    this.baseUrl = baseUrl;
    this.cacheTtlMs = cacheTtlMs;
    this.period = period;
    this._cache = new Map();
  }

  async _fetch(path) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance GET ${path} failed: ${res.status} ${text}`);
    }
    return await res.json();
  }

  async _cached(key, fn) {
    const entry = this._cache.get(key);
    if (entry && Date.now() - entry.ts < this.cacheTtlMs) {
      return entry.value;
    }
    try {
      const value = await fn();
      this._cache.set(key, { ts: Date.now(), value });
      return value;
    } catch (err) {
      console.warn(`⚠️  DerivativesProvider[${key}]: ${err.message}`);
      return null;
    }
  }

  /**
   * Top traders L/S — позиционирование "умных денег" (top счетов по нотионалу).
   *
   * Возвращает:
   *   {
   *     current: 1.79,        // long/short ratio (>1 = больше лонгов)
   *     previous: 1.76,
   *     delta: 0.03,          // знак показывает направление изменения
   *     longAccountPct: 64.16, // % счетов в лонге (для лога)
   *   }
   */
  async getTopLongShortRatio(symbol) {
    return this._cached(`topLS:${symbol}`, async () => {
      const data = await this._fetch(
        `/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(symbol)}&period=${this.period}&limit=2`,
      );
      if (!Array.isArray(data) || data.length < 2) return null;
      const [prev, curr] = data;
      const current = parseFloat(curr.longShortRatio);
      const previous = parseFloat(prev.longShortRatio);
      if (!isFinite(current) || !isFinite(previous)) return null;
      return {
        current,
        previous,
        delta: current - previous,
        longAccountPct: parseFloat(curr.longAccount) * 100,
        shortAccountPct: parseFloat(curr.shortAccount) * 100,
      };
    });
  }

  /**
   * Global account L/S — позиционирование розницы (по количеству счетов).
   *
   * Возвращает:
   *   {
   *     current: 1.37,
   *     previous: 1.35,
   *     delta: 0.02,
   *   }
   *
   * ИНТЕРПРЕТАЦИЯ: >2.0 = эйфория (контр-сигнал), <0.7 = паника (контр-сигнал),
   * 1.0-1.8 = нормальный режим.
   */
  async getCrowdLongShortRatio(symbol) {
    return this._cached(`crowdLS:${symbol}`, async () => {
      const data = await this._fetch(
        `/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=${this.period}&limit=2`,
      );
      if (!Array.isArray(data) || data.length < 2) return null;
      const [prev, curr] = data;
      const current = parseFloat(curr.longShortRatio);
      const previous = parseFloat(prev.longShortRatio);
      if (!isFinite(current) || !isFinite(previous)) return null;
      return {
        current,
        previous,
        delta: current - previous,
      };
    });
  }

  /**
   * Taker buy/sell ratio — соотношение агрессивных покупок и продаж.
   *
   * Возвращает:
   *   {
   *     current: 1.099,       // >1 = покупатели агрессивнее (бычий flow)
   *     previous: 0.655,
   *     delta: 0.444,
   *   }
   *
   * Это LEADING индикатор, в отличие от L/S который lagging.
   * Когда L/S и taker противоречат — taker важнее.
   */
  async getTakerRatio(symbol) {
    return this._cached(`taker:${symbol}`, async () => {
      const data = await this._fetch(
        `/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=${this.period}&limit=2`,
      );
      if (!Array.isArray(data) || data.length < 2) return null;
      const [prev, curr] = data;
      const current = parseFloat(curr.buySellRatio);
      const previous = parseFloat(prev.buySellRatio);
      if (!isFinite(current) || !isFinite(previous)) return null;
      return {
        current,
        previous,
        delta: current - previous,
      };
    });
  }

  /**
   * Open Interest history — общий открытый интерес и его изменение.
   *
   * Возвращает:
   *   {
   *     current: 12345.67,     // BTC
   *     previous: 12000.00,
   *     deltaPct: 2.88,        // относительное изменение в процентах
   *     trend: "RISING"|"FALLING"|"FLAT",
   *   }
   *
   * ВАЖНО: интерпретация требует контекста цены!
   *   OI растёт + цена растёт = новые лонги (бычий)
   *   OI растёт + цена падает = новые шорты (медвежий)
   *   OI падает + цена растёт = шорты закрываются (нейтр/бычий)
   *   OI падает + цена падает = лонги закрываются (медвежий)
   */
  async getOpenInterestHist(symbol) {
    return this._cached(`oi:${symbol}`, async () => {
      const data = await this._fetch(
        `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${this.period}&limit=2`,
      );
      if (!Array.isArray(data) || data.length < 2) return null;
      const [prev, curr] = data;
      const previousOI = parseFloat(prev.sumOpenInterest);
      const currentOI = parseFloat(curr.sumOpenInterest);
      if (!previousOI || !currentOI) return null;
      const deltaPct = ((currentOI - previousOI) / previousOI) * 100;
      let trend = "FLAT";
      if (deltaPct > 0.1) trend = "RISING";
      else if (deltaPct < -0.1) trend = "FALLING";
      return { currentOI, previousOI, deltaPct, trend };
    });
  }

  /**
   * Загрузить все деривативные метрики одним вызовом (параллельно).
   *
   * Возвращает:
   *   {
   *     topLS: {...} | null,
   *     crowdLS: {...} | null,
   *     taker: {...} | null,
   *     openInterest: {...} | null,
   *   }
   *
   * Если какие-то поля null — это не ошибка, стратегия их пропустит как
   * "не выполнено правило". Падение одной метрики не должно ронять весь цикл.
   */
  async loadAll(symbol) {
    const [topLS, crowdLS, taker, openInterest] = await Promise.all([
      this.getTopLongShortRatio(symbol),
      this.getCrowdLongShortRatio(symbol),
      this.getTakerRatio(symbol),
      this.getOpenInterestHist(symbol),
    ]);
    return { topLS, crowdLS, taker, openInterest };
  }

  /**
   * Принудительно сбросить кеш (например, после крупного движения цены).
   */
  invalidateCache(symbol = null) {
    if (symbol) {
      for (const key of this._cache.keys()) {
        if (key.endsWith(`:${symbol}`)) {
          this._cache.delete(key);
        }
      }
    } else {
      this._cache.clear();
    }
  }
}
