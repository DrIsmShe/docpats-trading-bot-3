import { BinanceFuturesClient } from "../providers/binanceFuturesClient.js";

/**
 * ExecutionService — отправка ордеров.
 *
 * РЕЖИМЫ:
 *   - paper:   создаёт позицию в PositionStore (без биржи)
 *   - live:    боевая торговля через BinanceFuturesClient
 *   - testnet: то же что live, но на testnet.binancefuture.com
 *
 * LIVE WORKFLOW:
 *   1. Получаем symbol info (tickSize, stepSize)
 *   2. Округляем quantity/цены
 *   3. Устанавливаем leverage и marginType ISOLATED
 *   4. Отправляем MARKET ордер (reduceOnly=false — open)
 *   5. ЖДЁМ исполнения через waitForOrderFill (polling)
 *   6. [FIX #1] Пересчитываем SL/TP от РЕАЛЬНОЙ avgPrice через slOffset/tpOffset
 *   7. Создаём запись в Mongo с реальной ценой
 *   8. SL/TP управляется программно через PositionMonitor
 *      (Binance отклоняет STOP_MARKET через /fapi/v1/order — ошибка -4120)
 *
 * =================================================================
 * ЗАЩИТЫ ПРОТИВ КАСКАДНЫХ ФЕЙЛОВ:
 * =================================================================
 *
 * [PROTECT #1] Большой таймаут waitForOrderFill (по умолчанию 60 сек)
 *   Было: 8 сек, потом 20 сек. Этого недостаточно при сетевых лагах
 *   или дрейфе времени. На 60 сек практически любой market-ордер
 *   успевает дойти до окончательного статуса.
 *
 * [PROTECT #2] Пост-таймаут verify через getOrder() с ретраями
 *   Таймаут ≠ «ордер не исполнился». Это значит только «мы не смогли
 *   подтвердить за N сек». Делаем ещё несколько проверок через getOrder
 *   на конкретный orderId, прежде чем считать ордер провальным.
 *
 * [PROTECT #3] КРИТИЧЕСКИЙ ФИКС 2026-04-26:
 *   Failure handling работает по getOrder(orderId), а НЕ по getPositions().
 *
 *   Старый баг: при unknown-таймауте бот звал getPositions(), видел
 *   суммарную позицию по символу (свою + ручную пользователя в One-Way
 *   Mode) и закрывал всю её через market. Это закрывало ручные
 *   позиции пользователя.
 *
 *   Сейчас: бот спрашивает Binance напрямую "что с НАШИМ ордером
 *   #orderId?" Если FILLED → записываем в БД, успех. Если NEW/PARTIAL
 *   → отменяем (cancelOrder). Если CANCELED/EXPIRED/REJECTED → ничего
 *   не делать. Если статус не получен → НЕ ТРОГАЕМ ничего, шлём
 *   Telegram-алерт. getPositions() в failure handling больше не
 *   используется — бот трогает ТОЛЬКО свои ордера.
 *
 * [PROTECT #4] Circuit breaker per-symbol
 *   3 последовательных провала по одному символу → блок символа на
 *   30 минут. Пока блок активен, execute() возвращает fail без
 *   похода на биржу. Сбрасывается при первой успешной сделке.
 *
 * [PROTECT #5] Global circuit breaker на timestamp ошибки (-1021)
 *   Это системная проблема (часы сервера), поэтому блокирует ВСЕХ.
 *   2 подряд → блок всего execute() на 5 минут.
 *
 * [PROTECT #6] closeMarketOrder вместо placeMarketOrder в close-путях
 *   closeMarketOrder в клиенте жёстко проставляет reduceOnly=true.
 *   Одна точка контроля вместо передачи флага в 3 местах.
 * =================================================================
 */

const TIMESTAMP_ERROR_CODE = "-1021";
const TIMESTAMP_ERROR_FRAGMENT = "recvWindow";

// Коды ошибок Binance, которые означают "ордера уже нет" — безопасно игнорируем
const ORDER_NOT_FOUND_FRAGMENTS = [
  "-2011", // Unknown order sent
  "Unknown order",
  "Order does not exist",
];

export class ExecutionService {
  constructor({
    mode = "paper",
    positionStore = null,
    binanceClient = null,
    symbolInfoCache = null,
    // Circuit breaker tuning
    symbolFailThreshold = 3, // 3 подряд по одному символу
    symbolBlockMs = 30 * 60 * 1000, // → блок на 30 мин
    globalFailThreshold = 2, // 2 подряд -1021 ошибки
    globalBlockMs = 5 * 60 * 1000, // → блок на 5 мин
    // Fill polling
    fillTimeoutMs = 60000, // 60 сек — основной таймаут (было 20)
    fillPollMs = 400, // интервал поллинга
    postTimeoutRetries = 3, // сколько раз ре-проверить через getOrder
    postTimeoutRetryDelayMs = 2000, // 2 сек между ретраями (было 1)
    // Telegram/observer hook. Вызывается при критичных событиях.
    onCircuitEvent = null,
    onSafetyAlert = null, // (msg) => void — Telegram-алерт о неподтверждённом ордере
  } = {}) {
    this.mode = mode;
    this.positionStore = positionStore;
    this.binanceClient = binanceClient;
    this._symbolInfoCache = symbolInfoCache ?? new Map();

    if (!positionStore) {
      throw new Error("ExecutionService requires positionStore");
    }
    if ((mode === "live" || mode === "testnet") && !binanceClient) {
      throw new Error(`ExecutionService mode=${mode} requires binanceClient`);
    }

    // Circuit breaker state
    this._cb = {
      symbolFailThreshold,
      symbolBlockMs,
      globalFailThreshold,
      globalBlockMs,
      // per-symbol: Map<symbol, { failures, blockedUntil, lastReason }>
      perSymbol: new Map(),
      // global state для timestamp ошибок
      globalTimestampFailures: 0,
      globalBlockedUntil: 0,
      globalLastReason: null,
    };

    this._fillTimeoutMs = fillTimeoutMs;
    this._fillPollMs = fillPollMs;
    this._postTimeoutRetries = postTimeoutRetries;
    this._postTimeoutRetryDelayMs = postTimeoutRetryDelayMs;
    this._onCircuitEvent =
      typeof onCircuitEvent === "function" ? onCircuitEvent : () => {};
    this._onSafetyAlert =
      typeof onSafetyAlert === "function" ? onSafetyAlert : () => {};
  }

  // ─── SYMBOL INFO CACHE ─────────────────────────────────────────

  async _getSymbolInfo(symbol) {
    if (this._symbolInfoCache.has(symbol)) {
      return this._symbolInfoCache.get(symbol);
    }
    const info = await this.binanceClient.getSymbolInfo(symbol);
    this._symbolInfoCache.set(symbol, info);
    return info;
  }

  // ─── CIRCUIT BREAKER ───────────────────────────────────────────

  _getSymbolState(symbol) {
    let s = this._cb.perSymbol.get(symbol);
    if (!s) {
      s = { failures: 0, blockedUntil: 0, lastReason: null };
      this._cb.perSymbol.set(symbol, s);
    }
    return s;
  }

  _isSymbolBlocked(symbol) {
    const s = this._getSymbolState(symbol);
    if (s.blockedUntil === 0) return false;
    const now = Date.now();
    if (now >= s.blockedUntil) {
      console.warn(
        `🟢 [CIRCUIT] Symbol ${symbol} block expired, resuming trading.`,
      );
      s.failures = 0;
      s.blockedUntil = 0;
      s.lastReason = null;
      this._emitCircuitEvent({ type: "symbol_unblock", symbol });
      return false;
    }
    return true;
  }

  _isGlobalBlocked() {
    const cb = this._cb;
    if (cb.globalBlockedUntil === 0) return false;
    const now = Date.now();
    if (now >= cb.globalBlockedUntil) {
      console.warn(
        `🟢 [CIRCUIT] Global block expired (was: ${cb.globalLastReason}), resuming trading.`,
      );
      cb.globalTimestampFailures = 0;
      cb.globalBlockedUntil = 0;
      cb.globalLastReason = null;
      this._emitCircuitEvent({ type: "global_unblock" });
      return false;
    }
    return true;
  }

  _recordSymbolFailure(symbol, reason) {
    const s = this._getSymbolState(symbol);
    s.failures++;
    s.lastReason = reason;

    if (s.failures >= this._cb.symbolFailThreshold) {
      s.blockedUntil = Date.now() + this._cb.symbolBlockMs;
      const mins = Math.round(this._cb.symbolBlockMs / 60000);
      console.error(
        `🔴 [CIRCUIT] Symbol ${symbol} BLOCKED for ${mins}min after ${s.failures} failures. Last: ${reason}`,
      );
      this._emitCircuitEvent({
        type: "symbol_block",
        symbol,
        failures: s.failures,
        reason,
        untilMs: s.blockedUntil,
      });
    } else {
      console.warn(
        `🟡 [CIRCUIT] Symbol ${symbol} failure ${s.failures}/${this._cb.symbolFailThreshold}: ${reason}`,
      );
    }
  }

  _recordSymbolSuccess(symbol) {
    const s = this._cb.perSymbol.get(symbol);
    if (s && s.failures > 0) {
      console.log(
        `🟢 [CIRCUIT] Symbol ${symbol} success — failure counter reset (was ${s.failures}).`,
      );
      s.failures = 0;
      s.lastReason = null;
    }
  }

  _isTimestampError(err) {
    const msg = String(err?.message ?? err ?? "");
    return (
      msg.includes(TIMESTAMP_ERROR_CODE) ||
      msg.includes(TIMESTAMP_ERROR_FRAGMENT)
    );
  }

  _isOrderNotFoundError(err) {
    const msg = String(err?.message ?? err ?? "");
    return ORDER_NOT_FOUND_FRAGMENTS.some((frag) => msg.includes(frag));
  }

  _recordGlobalTimestampFailure(reason) {
    const cb = this._cb;
    cb.globalTimestampFailures++;
    cb.globalLastReason = reason;
    if (cb.globalTimestampFailures >= cb.globalFailThreshold) {
      cb.globalBlockedUntil = Date.now() + cb.globalBlockMs;
      const mins = Math.round(cb.globalBlockMs / 60000);
      console.error(
        `🔴 [CIRCUIT] GLOBAL BLOCK for ${mins}min — timestamp drift (${cb.globalTimestampFailures} in a row). Check server clock (timedatectl / NTP).`,
      );
      this._emitCircuitEvent({
        type: "global_block",
        reason,
        failures: cb.globalTimestampFailures,
        untilMs: cb.globalBlockedUntil,
      });
    } else {
      console.warn(
        `🟡 [CIRCUIT] Timestamp error ${cb.globalTimestampFailures}/${cb.globalFailThreshold}: ${reason}`,
      );
    }
  }

  _recordGlobalSuccess() {
    const cb = this._cb;
    if (cb.globalTimestampFailures > 0) {
      cb.globalTimestampFailures = 0;
      cb.globalLastReason = null;
    }
  }

  _emitCircuitEvent(payload) {
    try {
      this._onCircuitEvent(payload);
    } catch (e) {
      console.warn(`⚠️  onCircuitEvent handler failed: ${e.message}`);
    }
  }

  _emitSafetyAlert(message) {
    try {
      this._onSafetyAlert(message);
    } catch (e) {
      console.warn(`⚠️  onSafetyAlert handler failed: ${e.message}`);
    }
  }

  /** Публично: узнать текущий статус бреакеров. Полезно для /status эндпоинта. */
  getCircuitStatus() {
    const now = Date.now();
    const perSymbol = {};
    for (const [symbol, s] of this._cb.perSymbol.entries()) {
      perSymbol[symbol] = {
        failures: s.failures,
        blocked: s.blockedUntil > now,
        blockedUntil: s.blockedUntil || null,
        blockedForMs: s.blockedUntil > now ? s.blockedUntil - now : 0,
        lastReason: s.lastReason,
      };
    }
    return {
      global: {
        blocked: this._cb.globalBlockedUntil > now,
        blockedUntil: this._cb.globalBlockedUntil || null,
        blockedForMs:
          this._cb.globalBlockedUntil > now
            ? this._cb.globalBlockedUntil - now
            : 0,
        timestampFailures: this._cb.globalTimestampFailures,
        lastReason: this._cb.globalLastReason,
      },
      perSymbol,
    };
  }

  /** Ручной сброс circuit breaker. Полезно после ручного вмешательства. */
  resetCircuitBreaker({ symbol = null, global: resetGlobal = false } = {}) {
    if (symbol) {
      const s = this._cb.perSymbol.get(symbol);
      if (s) {
        s.failures = 0;
        s.blockedUntil = 0;
        s.lastReason = null;
        console.log(`🟢 [CIRCUIT] Manual reset for ${symbol}`);
      }
    }
    if (resetGlobal) {
      this._cb.globalTimestampFailures = 0;
      this._cb.globalBlockedUntil = 0;
      this._cb.globalLastReason = null;
      console.log(`🟢 [CIRCUIT] Manual global reset`);
    }
  }

  // ─── PUBLIC ENTRYPOINT ─────────────────────────────────────────

  async execute(riskedSignal, { clientOrderPrefix = "BOT" } = {}) {
    if (!riskedSignal || !riskedSignal.allowed) {
      return {
        ok: false,
        reason: riskedSignal?.reason ?? "No trade plan",
      };
    }

    if (this.mode === "paper") {
      return this._executePaper(riskedSignal);
    }

    if (this.mode === "live" || this.mode === "testnet") {
      // [PROTECT #5] Global breaker check
      if (this._isGlobalBlocked()) {
        const ms = this._cb.globalBlockedUntil - Date.now();
        return {
          ok: false,
          reason: `circuit_breaker_global: timestamp drift, ${Math.round(ms / 1000)}s remaining`,
        };
      }
      // [PROTECT #4] Symbol breaker check
      if (this._isSymbolBlocked(riskedSignal.symbol)) {
        const s = this._getSymbolState(riskedSignal.symbol);
        const ms = s.blockedUntil - Date.now();
        return {
          ok: false,
          reason: `circuit_breaker_symbol: ${riskedSignal.symbol} blocked, ${Math.round(ms / 1000)}s remaining (last: ${s.lastReason})`,
        };
      }

      return await this._executeLive(riskedSignal, { clientOrderPrefix });
    }

    return { ok: false, reason: `Unknown mode: ${this.mode}` };
  }

  // ─── PAPER MODE ────────────────────────────────────────────────

  async _executePaper(signal) {
    const side = signal.type === "BUY" ? "LONG" : "SHORT";

    const position = await this.positionStore.open({
      symbol: signal.symbol,
      side,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      positionSize: signal.positionSize,
      notional: signal.positionNotional,
      leverage: signal.leverage,
      strategyId: signal.strategyId,
      strategyName: signal.strategyName,
      confidence: signal.confidence,
      reason: signal.reason,
      mlSignal: signal.mlSignal ?? "HOLD",
      mlConfidence: signal.mlConfidence ?? signal.confidence ?? 0,
    });

    console.log("\n" + "─".repeat(60));
    console.log(`📝 PAPER ORDER OPENED [${position.id}]`);
    console.log("─".repeat(60));
    console.log(`   ${position.symbol} ${position.side}`);
    console.log(`   Entry:  ${position.entry.toFixed(2)}`);
    console.log(`   SL:     ${position.stopLoss.toFixed(2)}`);
    console.log(`   TP:     ${position.takeProfit.toFixed(2)}`);
    console.log(`   Size:   ${position.positionSize.toFixed(6)} BTC`);
    console.log(`   Strategy: ${position.strategyName}`);
    console.log("─".repeat(60));

    return { ok: true, mode: "paper", position };
  }

  // ─── LIVE MODE ─────────────────────────────────────────────────

  async _executeLive(signal, { clientOrderPrefix }) {
    const { symbol, type, stopLoss, takeProfit, leverage } = signal;
    const side = type;

    let placedOrderId = null; // нужен в catch для финального резолва статуса

    try {
      // 1. Информация о символе
      const info = await this._getSymbolInfo(symbol);

      // 2. Округлить quantity к stepSize
      const rawQty = signal.positionSize;
      const quantity = BinanceFuturesClient.roundToStepSize(
        rawQty,
        info.stepSize,
      );

      if (quantity <= 0) {
        return {
          ok: false,
          reason: `positionSize too small after rounding (${rawQty} → ${quantity})`,
        };
      }

      // 3. Округлить SL/TP к tickSize (из сигнала — будет пересчитано после fill)
      const signalSL = BinanceFuturesClient.roundToTickSize(
        stopLoss,
        info.tickSize,
      );
      const signalTP = BinanceFuturesClient.roundToTickSize(
        takeProfit,
        info.tickSize,
      );

      // 4. Leverage + marginType ISOLATED
      try {
        await this.binanceClient.setMarginType(symbol, "ISOLATED");
      } catch (err) {
        if (!err.message.includes("No need to change")) {
          console.warn(`⚠️  setMarginType: ${err.message}`);
        }
      }
      try {
        await this.binanceClient.setLeverage(symbol, leverage);
      } catch (err) {
        console.warn(`⚠️  setLeverage: ${err.message}`);
      }

      // 5. clientOrderId с префиксом
      const clientOrderId = `${clientOrderPrefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

      console.log(
        `\n🔵 [${clientOrderPrefix}] Открытие позиции ${side} ${symbol}...`,
      );
      console.log(
        `   Qty: ${quantity} | Notional: ~$${(quantity * signal.entry).toFixed(2)}`,
      );
      console.log(
        `   Signal SL: ${signalSL} | TP: ${signalTP} | Lev: x${leverage}`,
      );

      // 6. MARKET ордер (OPEN — reduceOnly=false по умолчанию)
      const order = await this.binanceClient.placeMarketOrder({
        symbol,
        side,
        quantity,
        clientOrderId,
      });

      const orderId = order.orderId;
      placedOrderId = orderId;
      console.log(
        `📤 [${clientOrderPrefix}] Ордер отправлен #${orderId}, ждём fill...`,
      );

      // 7. ДОЖДАТЬСЯ FILL [PROTECT #1 + PROTECT #2 + PROTECT #3]
      const filledOrder = await this._resolveOrderOutcome(
        symbol,
        orderId,
        clientOrderPrefix,
      );

      if (!filledOrder.ok) {
        // _resolveOrderOutcome уже сделал безопасную обработку
        // (cancel если ордер висел, alert если статус неизвестен).
        // Никакого emergency close по getPositions().
        this._recordSymbolFailure(symbol, `open_fail: ${filledOrder.reason}`);
        return { ok: false, reason: filledOrder.reason };
      }

      const executedQty = parseFloat(filledOrder.data.executedQty);
      const avgPrice = parseFloat(filledOrder.data.avgPrice);

      if (executedQty === 0 || !avgPrice || avgPrice === 0) {
        console.error(
          `❌ Filled order has invalid data: ${JSON.stringify(filledOrder.data)}`,
        );
        // Не делаем emergency close — это не наш bug, а странный ответ Binance.
        // Шлём алерт и записываем fail.
        this._emitSafetyAlert(
          `⚠️ ${symbol} — ордер #${orderId} вернул невалидные данные ` +
            `(executedQty=${executedQty}, avgPrice=${avgPrice}). ` +
            `Проверьте состояние позиции на бирже вручную.`,
        );
        this._recordSymbolFailure(symbol, "invalid_fill_data");
        return { ok: false, reason: "Invalid fill data" };
      }

      console.log(
        `✅ [${clientOrderPrefix}] MARKET исполнен: ${executedQty} @ ${avgPrice}`,
      );

      // [FIX #1] Пересчитать SL/TP от РЕАЛЬНОЙ цены исполнения.
      let finalSL = signalSL;
      let finalTP = signalTP;
      if (
        typeof signal.slOffset === "number" &&
        typeof signal.tpOffset === "number" &&
        signal.slOffset > 0 &&
        signal.tpOffset > 0
      ) {
        const rawSL =
          side === "BUY"
            ? avgPrice - signal.slOffset
            : avgPrice + signal.slOffset;
        const rawTP =
          side === "BUY"
            ? avgPrice + signal.tpOffset
            : avgPrice - signal.tpOffset;
        finalSL = BinanceFuturesClient.roundToTickSize(rawSL, info.tickSize);
        finalTP = BinanceFuturesClient.roundToTickSize(rawTP, info.tickSize);

        if (finalSL !== signalSL || finalTP !== signalTP) {
          const drift = avgPrice - signal.entry;
          console.log(
            `   🔧 SL/TP recalc from fill (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}): SL ${signalSL} → ${finalSL}, TP ${signalTP} → ${finalTP}`,
          );
        }
      } else {
        console.warn(
          `   ⚠️  No slOffset/tpOffset in signal — using signal-time SL/TP as-is`,
        );
      }

      // 8. Запись в Mongo
      const domainSide = side === "BUY" ? "LONG" : "SHORT";
      const notional = executedQty * avgPrice;

      const position = await this.positionStore.open({
        symbol,
        side: domainSide,
        entry: avgPrice,
        stopLoss: finalSL,
        takeProfit: finalTP,
        positionSize: executedQty,
        notional,
        leverage,
        strategyId: signal.strategyId,
        strategyName: signal.strategyName,
        confidence: signal.confidence,
        reason: signal.reason,
        clientOrderId,
        orderId: String(orderId),
        mlSignal: signal.mlSignal ?? "HOLD",
        mlConfidence: signal.mlConfidence ?? signal.confidence ?? 0,
      });

      // 9. SL/TP управляется программно через PositionMonitor
      console.log(
        `🛡️  SL: ${finalSL} | TP: ${finalTP} → управляется PositionMonitor`,
      );

      console.log("─".repeat(60));
      console.log(`✅ LIVE POSITION OPENED [${position.id}]`);
      console.log(`   ${symbol} ${domainSide} ${executedQty} @ ${avgPrice}`);
      console.log(`   SL: ${finalSL} | TP: ${finalTP}`);
      console.log(`   Strategy: ${signal.strategyName}`);
      console.log("─".repeat(60));

      // Success — сбрасываем счётчики
      this._recordSymbolSuccess(symbol);
      this._recordGlobalSuccess();

      return {
        ok: true,
        mode: "live",
        position,
        order: filledOrder.data,
        slOrderId: null,
        tpOrderId: null,
      };
    } catch (err) {
      console.error(`\n❌ _executeLive failed: ${err.message}`);
      if (err.stack) console.error(err.stack);

      // Timestamp ошибка — глобальный breaker
      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(err.message);
      } else {
        this._recordSymbolFailure(symbol, `exchange_error: ${err.message}`);
      }

      // [PROTECT #3] Если у нас есть orderId — пытаемся узнать его судьбу
      // и обработать (cancel если висит / алерт если неизвестно).
      // НЕ зовём getPositions() — не трогаем чужие позиции.
      if (placedOrderId !== null) {
        await this._tryResolveOrphanedOrder(
          symbol,
          placedOrderId,
          err.message,
        ).catch(() => {});
      }

      return { ok: false, reason: `Exchange error: ${err.message}` };
    }
  }

  // ─── ORDER OUTCOME RESOLUTION ──────────────────────────────────

  /**
   * [PROTECT #1 + #2 + #3] Определить судьбу ордера и обработать БЕЗОПАСНО.
   *
   * Алгоритм:
   *   1. waitForOrderFill (60 сек) — ждём FILLED
   *   2. Если таймаут / ошибка → ещё N доп. проверок через getOrder
   *      (с задержкой между ними), каждый раз только по нашему orderId
   *   3. По финальному статусу:
   *        FILLED              → ok: true (продолжаем нормально)
   *        PARTIALLY_FILLED    → cancelOrder + ok: false (qty < expected)
   *        NEW                 → cancelOrder + ok: false (был висящим)
   *        CANCELED/EXPIRED/REJECTED → ok: false (без действий)
   *        Не определили статус → ok: false + Telegram-алерт + НЕ трогаем биржу
   *
   * Возвращает { ok: true, data: orderLike } или { ok: false, reason }
   *
   * НИКОГДА не зовёт getPositions() и не закрывает чужие позиции.
   */
  async _resolveOrderOutcome(symbol, orderId, clientOrderPrefix) {
    let lastKnownStatus = null;

    // Стадия 1: основное ожидание fill через waitForOrderFill
    try {
      const filled = await this.binanceClient.waitForOrderFill(
        symbol,
        orderId,
        this._fillTimeoutMs,
        this._fillPollMs,
      );
      // FILLED обработан внутри waitForOrderFill
      return { ok: true, data: filled };
    } catch (err) {
      const msg = err?.message || "";
      console.warn(
        `⚠️  [${clientOrderPrefix}] waitForOrderFill not confirmed: ${msg}. Re-checking #${orderId}...`,
      );

      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(msg);
      }

      // Если waitForOrderFill кинул конкретный финальный статус — берём его
      const finalStatusInMsg = this._extractFinalStatusFromError(msg);
      if (finalStatusInMsg) {
        lastKnownStatus = finalStatusInMsg;
      }
    }

    // Стадия 2: пост-таймаут ретраи через getOrder (только наш orderId)
    let lastOrderData = null;
    for (let attempt = 1; attempt <= this._postTimeoutRetries; attempt++) {
      await this._sleep(this._postTimeoutRetryDelayMs);
      try {
        const check = await this.binanceClient.getOrder(symbol, orderId);
        lastOrderData = check;
        lastKnownStatus = check?.status ?? lastKnownStatus;

        console.log(
          `   🔎 post-timeout check ${attempt}/${this._postTimeoutRetries}: status=${check?.status}, executedQty=${check?.executedQty}`,
        );

        if (check?.status === "FILLED") {
          console.log(
            `   ✅ Order #${orderId} was actually filled — continuing normally.`,
          );
          return { ok: true, data: check };
        }

        if (
          check?.status === "CANCELED" ||
          check?.status === "EXPIRED" ||
          check?.status === "REJECTED"
        ) {
          // Финальный неуспешный статус — ничего отменять/закрывать не надо
          return {
            ok: false,
            reason: `order_${String(check.status).toLowerCase()}`,
          };
        }

        // NEW / PARTIALLY_FILLED — продолжаем проверять
      } catch (checkErr) {
        const cmsg = checkErr?.message || "";
        console.warn(
          `   ⚠️  post-timeout getOrder attempt ${attempt} failed: ${cmsg}`,
        );
        if (this._isTimestampError(checkErr)) {
          this._recordGlobalTimestampFailure(cmsg);
        }
        // Не выходим — продолжим следующую попытку
      }
    }

    // Стадия 3: обработка по последнему известному статусу
    return await this._handleNonFilledOutcome(
      symbol,
      orderId,
      lastKnownStatus,
      lastOrderData,
      clientOrderPrefix,
    );
  }

  /**
   * Парсит финальный статус из сообщения ошибки waitForOrderFill.
   * Например: "Order 123 EXPIRED:" или "Order 123 CANCELED:"
   */
  _extractFinalStatusFromError(msg) {
    if (!msg) return null;
    const m = msg.match(/Order \d+ (FILLED|EXPIRED|CANCELED|REJECTED)/);
    return m ? m[1] : null;
  }

  /**
   * Обработка ордера с НЕ-FILLED финальным статусом.
   *
   * NEW / PARTIALLY_FILLED → cancelOrder, чтобы не получить отложенный fill
   * Неизвестно           → НЕ трогать биржу, Telegram-алерт
   */
  async _handleNonFilledOutcome(
    symbol,
    orderId,
    lastKnownStatus,
    lastOrderData,
    clientOrderPrefix,
  ) {
    const statusUpper = lastKnownStatus
      ? String(lastKnownStatus).toUpperCase()
      : null;

    if (statusUpper === "NEW" || statusUpper === "PARTIALLY_FILLED") {
      // Ордер ещё активен — отменяем, чтобы не висел и не fill'ился задним числом.
      console.warn(
        `   🛑 [${clientOrderPrefix}] Order #${orderId} still active (${statusUpper}). Cancelling...`,
      );
      try {
        await this.binanceClient.cancelOrder(symbol, orderId);
        console.warn(
          `   ✅ [${clientOrderPrefix}] Order #${orderId} cancelled successfully.`,
        );
      } catch (cancelErr) {
        const cmsg = cancelErr?.message || "";
        if (this._isOrderNotFoundError(cancelErr)) {
          // Ордер успел исполниться или был отменён биржей —
          // в любом случае дополнительных действий не требуется.
          console.log(
            `   ℹ️  [${clientOrderPrefix}] Order #${orderId} already gone (${cmsg.slice(0, 80)}).`,
          );
        } else {
          console.error(
            `   ❌ [${clientOrderPrefix}] cancelOrder failed: ${cmsg}`,
          );
          this._emitSafetyAlert(
            `❌ ${symbol} — не удалось отменить висящий ордер #${orderId}.\n` +
              `Status: ${statusUpper}\n` +
              `Error: ${cmsg}\n` +
              `Проверьте Open Orders на Binance.`,
          );
          if (this._isTimestampError(cancelErr)) {
            this._recordGlobalTimestampFailure(cmsg);
          }
        }
      }

      // Если был частичный fill — об этом нужно знать,
      // т.к. на бирже теперь висит маленькая позиция, которой нет в БД.
      const executed = parseFloat(lastOrderData?.executedQty ?? 0);
      if (executed > 0) {
        this._emitSafetyAlert(
          `⚠️ ${symbol} — partial fill при cancel: ` +
            `${executed} (orderId ${orderId}). ` +
            `На бирже теперь маленькая позиция, которой нет в БД. ` +
            `Закройте вручную через Binance UI.`,
        );
        return {
          ok: false,
          reason: `partial_fill_cancelled: executed=${executed}`,
        };
      }

      return {
        ok: false,
        reason: `order_${statusUpper.toLowerCase()}_cancelled`,
      };
    }

    if (
      statusUpper === "CANCELED" ||
      statusUpper === "EXPIRED" ||
      statusUpper === "REJECTED"
    ) {
      // Ордер уже не активен и не исполнен — действий не требуется.
      return { ok: false, reason: `order_${statusUpper.toLowerCase()}` };
    }

    // Статус неизвестен — НЕ ТРОГАЕМ биржу. Самый безопасный исход.
    console.error(
      `   🚨 [${clientOrderPrefix}] Cannot determine final status for #${orderId}. Sending alert, NOT touching positions.`,
    );
    this._emitSafetyAlert(
      `🚨 ${symbol} — не удалось определить финальный статус ордера #${orderId}.\n` +
        `Возможные исходы:\n` +
        `  • ордер исполнился, и бот про это не знает (на бирже появилась позиция без записи в БД)\n` +
        `  • ордер всё ещё висит\n` +
        `Проверьте Order History и Open Orders на Binance.\n` +
        `На следующем рестарте reconcileOnStartup пришлёт алерт об orphan-позиции если она есть.`,
    );

    return {
      ok: false,
      reason: `Order fill unconfirmed and final status unknown after ${this._postTimeoutRetries} retries`,
    };
  }

  /**
   * Вызывается из catch _executeLive, если произошла исключительная ошибка
   * после отправки ордера. Делает best-effort попытку узнать судьбу нашего
   * ордера и обработать (cancel если висит / алерт).
   *
   * НЕ закрывает позиции и НЕ зовёт getPositions().
   */
  async _tryResolveOrphanedOrder(symbol, orderId, originalErrorMessage) {
    try {
      await this._sleep(1500);
      const order = await this.binanceClient.getOrder(symbol, orderId);
      const status = String(order?.status ?? "").toUpperCase();

      if (status === "FILLED") {
        // Ордер исполнился, но мы свалились до записи в БД.
        // Алертим — пользователь должен знать.
        const executed = parseFloat(order.executedQty ?? 0);
        const avgPrice = parseFloat(order.avgPrice ?? 0);
        this._emitSafetyAlert(
          `🚨 ${symbol} — ордер #${orderId} исполнился (${executed} @ ${avgPrice}), ` +
            `но запись в БД не создана из-за ошибки:\n${originalErrorMessage}\n` +
            `На бирже открыта позиция без управления ботом. ` +
            `На следующем рестарте reconcileOnStartup это обнаружит.`,
        );
        return;
      }

      if (status === "NEW" || status === "PARTIALLY_FILLED") {
        // Висит — отменяем
        try {
          await this.binanceClient.cancelOrder(symbol, orderId);
        } catch (cancelErr) {
          if (!this._isOrderNotFoundError(cancelErr)) {
            console.warn(`   ⚠️  Orphan cancel failed: ${cancelErr.message}`);
          }
        }
        const executed = parseFloat(order.executedQty ?? 0);
        if (executed > 0) {
          this._emitSafetyAlert(
            `⚠️ ${symbol} — partial fill (${executed}) у ордера #${orderId}, ` +
              `которая повисла на бирже без записи в БД. Закройте вручную.`,
          );
        }
        return;
      }

      // CANCELED / EXPIRED / REJECTED — ничего делать не нужно
    } catch (err) {
      // getOrder упал — самый безопасный исход: алерт и без действий
      this._emitSafetyAlert(
        `⚠️ ${symbol} — после ошибки execute не удалось проверить ордер #${orderId}.\n` +
          `Original error: ${originalErrorMessage}\n` +
          `Status check error: ${err.message}\n` +
          `Проверьте Order History на Binance.`,
      );
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─── CLOSE PAPER ────────────────────────────────────────────────

  async closePaper(positionId, { exitPrice, exitReason }) {
    if (this.mode !== "paper") {
      throw new Error("closePaper: only available in paper mode");
    }

    const closed = await this.positionStore.close(positionId, {
      exitPrice,
      exitReason,
    });
    if (!closed) return null;

    const sign = closed.pnl >= 0 ? "+" : "";
    const emoji = closed.pnl >= 0 ? "💚" : "❤️";

    console.log("\n" + "─".repeat(60));
    console.log(`${emoji} PAPER POSITION CLOSED [${closed.id}]`);
    console.log("─".repeat(60));
    console.log(`   ${closed.symbol} ${closed.side}`);
    console.log(
      `   Entry → Exit: ${closed.entry.toFixed(2)} → ${closed.exitPrice.toFixed(2)}`,
    );
    console.log(`   Reason: ${closed.exitReason}`);
    console.log(`   PnL:    ${sign}$${closed.pnl.toFixed(2)}`);
    console.log("─".repeat(60));

    return closed;
  }

  // ─── CLOSE LIVE ────────────────────────────────────────────────

  /**
   * Ручное закрытие live-позиции.
   *
   * Закрывает ТОЛЬКО позицию, известную боту (по position.positionSize),
   * через closeMarketOrder с reduceOnly=true. Это безопасно — reduceOnly
   * на стороне Binance гарантирует, что ордер не превысит размер
   * существующей позиции.
   */
  async closeLive(positionId, { exitReason = "MANUAL" } = {}) {
    if (this.mode !== "live" && this.mode !== "testnet") {
      throw new Error("closeLive: only available in live/testnet mode");
    }

    const position = await this.positionStore.getById(positionId);
    if (!position || position.status !== "OPEN") {
      console.warn(`⚠️  closeLive: position ${positionId} not open`);
      return null;
    }

    try {
      // Не зовём cancelAllOrders — это может отменить пользовательские
      // SL/TP-ордера, которые висят на бирже отдельно от наших.

      const closeSide = position.side === "LONG" ? "SELL" : "BUY";
      const closeOrderId = `CLOSE_${Date.now()}`;

      const closeOrder = await this.binanceClient.closeMarketOrder({
        symbol: position.symbol,
        side: closeSide,
        quantity: position.positionSize,
        clientOrderId: closeOrderId,
      });

      const fillRes = await this._resolveOrderOutcome(
        position.symbol,
        closeOrder.orderId,
        "CLOSE",
      );

      if (!fillRes.ok) {
        console.error(
          `❌ closeLive: close order outcome unclear (${fillRes.reason}). Manual review required.`,
        );
        this._emitSafetyAlert(
          `❌ closeLive failed for ${position.symbol} ${position.side}\n` +
            `Position id: ${positionId}\n` +
            `Reason: ${fillRes.reason}\n` +
            `Проверьте состояние позиции на бирже вручную.`,
        );
        return null;
      }

      const exitPrice = parseFloat(fillRes.data.avgPrice);
      return await this._finalizeLiveClose(
        positionId,
        position,
        exitPrice,
        exitReason,
      );
    } catch (err) {
      console.error(`❌ closeLive failed: ${err.message}`);
      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(err.message);
      }
      this._emitSafetyAlert(
        `❌ closeLive exception for ${position.symbol} ${position.side}\n` +
          `Position id: ${positionId}\n` +
          `Error: ${err.message}`,
      );
      return null;
    }
  }

  async _finalizeLiveClose(positionId, position, exitPrice, exitReason) {
    const closed = await this.positionStore.close(positionId, {
      exitPrice,
      exitReason,
    });
    if (!closed) return null;

    const sign = closed.pnl >= 0 ? "+" : "";
    const emoji = closed.pnl >= 0 ? "💚" : "❤️";

    console.log("\n" + "─".repeat(60));
    console.log(`${emoji} LIVE POSITION CLOSED [${closed.id}]`);
    console.log(`   ${closed.symbol} ${closed.side}`);
    console.log(
      `   Entry → Exit: ${closed.entry.toFixed(2)} → ${exitPrice.toFixed(2)}`,
    );
    console.log(`   Reason: ${exitReason}`);
    console.log(`   PnL:    ${sign}$${closed.pnl.toFixed(2)}`);
    console.log("─".repeat(60));

    return closed;
  }
}
