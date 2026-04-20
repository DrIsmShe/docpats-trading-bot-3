import crypto from "crypto";

export class BinanceFuturesClient {
  constructor({ apiKey, apiSecret, testnet = false } = {}) {
    if (!apiKey || !apiSecret) {
      throw new Error("BinanceFuturesClient requires apiKey and apiSecret");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";
    this.testnet = testnet;
  }

  _sign(queryString) {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(queryString)
      .digest("hex");
  }

  _toQuery(params) {
    return Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
  }

  async _publicRequest(method, path, params = {}) {
    const query = this._toQuery(params);
    const url = `${this.baseUrl}${path}${query ? "?" + query : ""}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Binance ${method} ${path} failed: ${res.status} ${text}`,
      );
    }
    return await res.json();
  }

  async _signedRequest(method, path, params = {}) {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const allParams = { ...params, timestamp, recvWindow };
    const query = this._toQuery(allParams);
    const signature = this._sign(query);
    const finalQuery = `${query}&signature=${signature}`;
    const url = `${this.baseUrl}${path}?${finalQuery}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Binance ${method} ${path} failed: ${res.status} ${text}`,
      );
    }
    return await res.json();
  }

  async getCandles(symbol, interval, limit = 500, endTime = null) {
    const params = { symbol, interval, limit };
    if (endTime) params.endTime = endTime;
    const raw = await this._publicRequest("GET", "/fapi/v1/klines", params);
    return raw.map((k) => ({
      symbol,
      interval,
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      buyVolume: parseFloat(k[9]),
    }));
  }

  async getPrice(symbol) {
    const data = await this._publicRequest("GET", "/fapi/v1/ticker/price", {
      symbol,
    });
    return parseFloat(data.price);
  }

  async getSymbolInfo(symbol) {
    const data = await this._publicRequest("GET", "/fapi/v1/exchangeInfo");
    const info = data.symbols.find((s) => s.symbol === symbol);
    if (!info) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
    const lotSizeFilter = info.filters.find((f) => f.filterType === "LOT_SIZE");
    const priceFilter = info.filters.find(
      (f) => f.filterType === "PRICE_FILTER",
    );
    const minNotionalFilter = info.filters.find(
      (f) => f.filterType === "MIN_NOTIONAL",
    );
    return {
      symbol: info.symbol,
      pricePrecision: info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
      tickSize: parseFloat(priceFilter.tickSize),
      stepSize: parseFloat(lotSizeFilter.stepSize),
      minQty: parseFloat(lotSizeFilter.minQty),
      maxQty: parseFloat(lotSizeFilter.maxQty),
      minNotional: parseFloat(minNotionalFilter?.notional ?? 5),
    };
  }

  async getBalance() {
    const data = await this._signedRequest("GET", "/fapi/v2/balance");
    const usdt = data.find((b) => b.asset === "USDT");
    if (!usdt) return { totalWalletBalance: 0, availableBalance: 0 };
    return {
      totalWalletBalance: parseFloat(usdt.balance),
      availableBalance: parseFloat(usdt.availableBalance),
    };
  }

  async getPositions() {
    const data = await this._signedRequest("GET", "/fapi/v2/positionRisk");
    return data
      .filter((p) => parseFloat(p.positionAmt) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedProfit: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage),
        side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
      }));
  }

  async getOpenOrders(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this._signedRequest("GET", "/fapi/v1/openOrders", params);
  }

  async getOrder(symbol, orderId) {
    return await this._signedRequest("GET", "/fapi/v1/order", {
      symbol,
      orderId,
    });
  }

  async waitForOrderFill(
    symbol,
    orderId,
    maxWaitMs = 8000,
    pollIntervalMs = 300,
  ) {
    const startTime = Date.now();
    let lastOrder = null;
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const order = await this.getOrder(symbol, orderId);
        lastOrder = order;
        if (order.status === "FILLED") return order;
        if (order.status === "PARTIALLY_FILLED") {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        if (["EXPIRED", "CANCELED", "REJECTED"].includes(order.status)) {
          throw new Error(
            `Order ${orderId} ${order.status}: ${order.rejectReason ?? ""}`,
          );
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      } catch (err) {
        if (
          err.message.includes("Order does not exist") ||
          err.message.includes("Unknown order")
        ) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        throw err;
      }
    }
    try {
      await this._signedRequest("DELETE", "/fapi/v1/order", {
        symbol,
        orderId,
      });
    } catch (err) {}
    throw new Error(
      `Order ${orderId} not filled within ${maxWaitMs}ms. Last status: ${lastOrder?.status ?? "unknown"}`,
    );
  }

  async setLeverage(symbol, leverage) {
    return await this._signedRequest("POST", "/fapi/v1/leverage", {
      symbol,
      leverage,
    });
  }

  async setMarginType(symbol, marginType = "ISOLATED") {
    try {
      return await this._signedRequest("POST", "/fapi/v1/marginType", {
        symbol,
        marginType,
      });
    } catch (err) {
      if (err.message.includes("No need to change margin type"))
        return { msg: "already_set" };
      throw err;
    }
  }

  /**
   * Разместить MARKET-ордер.
   *
   * Для ОТКРЫТИЯ позиций: reduceOnly=false (по умолчанию).
   * Для ЗАКРЫТИЯ позиций: ВСЕГДА используйте closeMarketOrder() — он
   * гарантированно выставит reduceOnly=true. Не вызывайте placeMarketOrder
   * с reduceOnly=true напрямую в close-сценариях: closeMarketOrder делает
   * намерение явным и защищает от случайных flip-ордеров в будущем коде.
   */
  async placeMarketOrder({
    symbol,
    side,
    quantity,
    clientOrderId,
    reduceOnly = false,
  }) {
    const params = { symbol, side, type: "MARKET", quantity };
    if (clientOrderId) params.newClientOrderId = clientOrderId;
    if (reduceOnly) params.reduceOnly = "true";
    return await this._signedRequest("POST", "/fapi/v1/order", params);
  }

  /**
   * [GAP #3] Явный метод для закрытия позиций.
   *
   * Всегда отправляет ордер с reduceOnly=true, что гарантирует:
   *   - ордер только уменьшит/закроет существующую позицию
   *   - никогда не откроет обратную (flip → orphan)
   *
   * Весь close-код в боте (PositionMonitor, emergency close, ручное
   * закрытие по timeout) должен использовать этот метод, а не
   * placeMarketOrder напрямую.
   */
  async closeMarketOrder({ symbol, side, quantity, clientOrderId }) {
    return await this.placeMarketOrder({
      symbol,
      side,
      quantity,
      clientOrderId,
      reduceOnly: true,
    });
  }

  async placeStopMarket({ symbol, side, stopPrice, quantity, clientOrderId }) {
    const params = {
      symbol,
      side,
      type: "STOP_MARKET",
      stopPrice,
      quantity,
      reduceOnly: "true",
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;
    return await this._signedRequest("POST", "/fapi/v1/order", params);
  }

  async placeTakeProfitMarket({
    symbol,
    side,
    stopPrice,
    quantity,
    clientOrderId,
  }) {
    const params = {
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      stopPrice,
      quantity,
      reduceOnly: "true",
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;
    return await this._signedRequest("POST", "/fapi/v1/order", params);
  }

  async closePosition(symbol) {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) throw new Error(`No open position for ${symbol}`);
    const closeSide = pos.side === "LONG" ? "SELL" : "BUY";
    return await this.closeMarketOrder({
      symbol,
      side: closeSide,
      quantity: Math.abs(pos.positionAmt),
    });
  }

  async cancelAllOrders(symbol) {
    return await this._signedRequest("DELETE", "/fapi/v1/allOpenOrders", {
      symbol,
    });
  }

  static roundToStepSize(quantity, stepSize) {
    return Math.floor(quantity / stepSize) * stepSize;
  }

  static roundToTickSize(price, tickSize) {
    return Math.round(price / tickSize) * tickSize;
  }
}
