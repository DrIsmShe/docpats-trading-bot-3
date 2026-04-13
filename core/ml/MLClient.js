/**
 * MLClient — HTTP клиент к ml-service.
 */
export class MLClient {
  constructor({ baseUrl = "http://localhost:3001", timeout = 10000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  async _request(path, body) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `HTTP ${response.status}: ${text}` };
      }

      const data = await response.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async predict({ candles1h, candles4h = [], candles1d = [] }) {
    const result = await this._request("/predict", {
      candles1h,
      candles4h,
      candles1d,
      fundingRate: [],
      openInterest: [],
      longShortRatio: [],
    });
    if (!result.ok) {
      console.warn(`⚠️  ML predict: ${result.error}`);
      return null;
    }
    return result.data;
  }

  /**
   * Отправить фидбек о закрытой сделке.
   * ml-service сам построит sequence из свечей и сохранит для дообучения.
   */
  async feedback({
    side,
    entryPrice,
    exitPrice,
    pnlUSDT,
    strategy,
    mlSignal = null,
    mlConfidence = null,
    closeReason,
    candles1h,
    candles4h = [],
    candles1d = [],
  }) {
    const result = await this._request("/feedback", {
      side,
      entryPrice,
      exitPrice,
      pnlUSDT,
      strategy,
      mlSignal,
      mlConfidence,
      closeReason,
      candles1h,
      candles4h,
      candles1d,
      fundingRate: [],
      openInterest: [],
      longShortRatio: [],
    });
    if (!result.ok) {
      console.warn(`⚠️  ML feedback: ${result.error}`);
      return null;
    }
    return result.data;
  }

  async status() {
    try {
      const response = await fetch(`${this.baseUrl}/status`);
      return await response.json();
    } catch (err) {
      return null;
    }
  }
}
