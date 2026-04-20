/**
 * MarketContextProvider — источник мета-рыночных данных.
 *
 * В отличие от свечей и индикаторов (цена), это контекстные данные:
 *   - Funding rate (кто платит на фьючерсах — лонги или шорты)
 *   - Open interest (суммарный объём открытых позиций)
 *   - Time context (текущий час/день UTC, флаг "опасное время")
 *
 * Используется стратегиями как мягкий фильтр: при "плохих" условиях
 * повышается требуемый порог confidence, но не блокируется полностью.
 *
 * Данные берутся бесплатно с публичных Binance endpoints:
 *   - GET /fapi/v1/premiumIndex        → funding rate + next funding time
 *   - GET /futures/data/openInterestHist → исторические точки OI
 *
 * Все методы — best effort: если Binance недоступен, возвращаются null
 * и стратегии работают без этого фильтра (не падают).
 */
export class MarketContextProvider {
  constructor({
    baseUrl = "https://fapi.binance.com",
    cacheTtlMs = 60_000,
  } = {}) {
    this.baseUrl = baseUrl;
    this.cacheTtlMs = cacheTtlMs;
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
      console.warn(`⚠️  MarketContextProvider[${key}]: ${err.message}`);
      return null;
    }
  }

  /**
   * Текущий funding rate для символа.
   *
   * Возвращает:
   *   {
   *     rate: 0.00012,           // 0.012% (дробь, не процент)
   *     ratePct: 0.012,          // уже в процентах — удобно для сравнений
   *     nextFundingTime: 1234,   // timestamp ms
   *     markPrice: 75000
   *   }
   *
   * При ошибке сети — null.
   */
  async getFundingRate(symbol) {
    return this._cached(`funding:${symbol}`, async () => {
      const data = await this._fetch(
        `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
      );
      const rate = parseFloat(data.lastFundingRate);
      return {
        rate,
        ratePct: rate * 100,
        nextFundingTime: parseInt(data.nextFundingTime),
        markPrice: parseFloat(data.markPrice),
      };
    });
  }

  /**
   * Дельта Open Interest за последний час (в процентах).
   *
   * Возвращает:
   *   {
   *     currentOI: 12345.67,      // BTC
   *     previousOI: 12000.00,
   *     deltaPct: 2.88,           // +2.88% за час
   *     trend: "RISING"|"FALLING"|"FLAT"
   *   }
   *
   * При ошибке — null. Если 2 последних точки слишком близкие (<0.1%) → FLAT.
   */
  async getOpenInterestTrend(symbol) {
    return this._cached(`oi:${symbol}`, async () => {
      const data = await this._fetch(
        `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=1h&limit=2`,
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
   * Определение временного контекста для трейдинга.
   *
   * "Опасные часы" — когда ликвидность тонкая, риск whipsaw выше:
   *   - Выходные (Sat/Sun) вечером: 20:00 UTC до 00:00 UTC
   *   - Можно расширить позже (азиатская ночь, час вокруг US market close)
   *
   * Возвращается синхронно (нет I/O), всегда свежий результат.
   */
  getTimeContext(now = new Date()) {
    const dow = now.getUTCDay(); // 0=Sun, 6=Sat
    const hour = now.getUTCHours();
    const isWeekend = dow === 0 || dow === 6;
    const isLateHour = hour >= 20; // 20:00-23:59 UTC

    // Пока одна эвристика: выходные вечером. Место для новых правил позже.
    const isWeekendNight = isWeekend && isLateHour;

    return {
      utcHour: hour,
      utcDayOfWeek: dow,
      isWeekend,
      isWeekendNight,
      // Общий флаг "рискованного времени" — стратегии читают его
      isRiskyHour: isWeekendNight,
      reason: isWeekendNight ? "weekend_night" : null,
    };
  }

  /**
   * Собрать полный marketContext одним объектом.
   * Используется MarketLoader-ом.
   */
  async loadFull(symbol) {
    const [funding, oi] = await Promise.all([
      this.getFundingRate(symbol),
      this.getOpenInterestTrend(symbol),
    ]);
    return {
      funding, // может быть null
      openInterest: oi, // может быть null
      time: this.getTimeContext(),
    };
  }
}
