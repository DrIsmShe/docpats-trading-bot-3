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
 * ЗАЩИТЫ ПРОТИВ КАСКАДНЫХ ФЕЙЛОВ (после инцидента 2026-04-23):
 * =================================================================
 *
 * [PROTECT #1] Увеличенный таймаут waitForOrderFill (20 сек)
 *   Было: 8 сек. При любой задержке сети или дрейфе времени — провал,
 *   даже если ордер фактически уже исполнен.
 *
 * [PROTECT #2] Пост-таймаут verify через getOrder() с ретраями
 *   Таймаут ≠ «ордер не исполнился». Это значит только «мы не смогли
 *   подтвердить за N сек». Перед выводом о провале — 3 доп. проверки.
 *
 * [PROTECT #3] Verify позиции на бирже ПЕРЕД любым emergency close
 *   Если getPositions() показывает 0 — значит позиции нет (ордер не
 *   прошёл или уже закрылся), и слать close не нужно. Иначе риск
 *   переворота при ошибке reduceOnly или при двойной обработке.
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
    fillTimeoutMs = 20000, // 20 сек основной таймаут
    fillPollMs = 400, // интервал поллинга
    postTimeoutRetries = 3, // сколько раз ре-проверить через getOrder
    postTimeoutRetryDelayMs = 1000,
    // Telegram/observer hook. Вызывается при: open block, unblock.
    onCircuitEvent = null,
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
      console.log(
        `📤 [${clientOrderPrefix}] Ордер отправлен #${orderId}, ждём fill...`,
      );

      // 7. ДОЖДАТЬСЯ FILL [PROTECT #1 + PROTECT #2]
      const filledOrder = await this._waitForFillWithVerify(
        symbol,
        orderId,
        clientOrderPrefix,
      );

      if (!filledOrder.ok) {
        // Надёжно определили что fill не произошёл → проверяем биржу и выходим
        await this._handleOpenFailure(symbol, filledOrder.reason);
        this._recordSymbolFailure(symbol, `open_fail: ${filledOrder.reason}`);
        return { ok: false, reason: filledOrder.reason };
      }

      const executedQty = parseFloat(filledOrder.data.executedQty);
      const avgPrice = parseFloat(filledOrder.data.avgPrice);

      if (executedQty === 0 || !avgPrice || avgPrice === 0) {
        console.error(
          `❌ Filled order has invalid data: ${JSON.stringify(filledOrder.data)}`,
        );
        await this._handleOpenFailure(symbol, "invalid_fill_data");
        this._recordSymbolFailure(symbol, "invalid_fill_data");
        return { ok: false, reason: "Invalid fill data" };
      }

      console.log(
        `✅ [${clientOrderPrefix}] MARKET исполнен: ${executedQty} @ ${avgPrice}`,
      );

      // [FIX #1] Пересчитать SL/TP от РЕАЛЬНОЙ цены исполнения.
      //
      // До фикса: SL/TP считались от signal.entry (last.close на момент сигнала).
      // Если за время отправки ордера цена ушла — сохранённый SL мог оказаться
      // вплотную к entry (или даже на неправильной стороне), что вызывало
      // мгновенный SL на первом же тике PositionMonitor.
      //
      // После фикса: если стратегия передала slOffset/tpOffset — применяем их
      // к avgPrice. Получаем стабильное расстояние SL/TP независимо от slippage.
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
        // [FIX #3] fallback на signal.confidence для стратегий,
        // которые не знают про поле mlConfidence (например Breakout)
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

      // [PROTECT #3] verify + safe close
      await this._handleOpenFailure(symbol, err.message);

      return { ok: false, reason: `Exchange error: ${err.message}` };
    }
  }

  // ─── FILL HANDLING ─────────────────────────────────────────────

  /**
   * [PROTECT #1 + #2] Ждём fill с увеличенным таймаутом. Если таймаут истёк —
   * делаем до N доп. проверок через getOrder() чтобы отделить «реально не
   * исполнился» от «мы не смогли подтвердить».
   *
   * Возвращает { ok: true, data: orderLike } или { ok: false, reason }
   */
  async _waitForFillWithVerify(symbol, orderId, clientOrderPrefix) {
    try {
      const filled = await this.binanceClient.waitForOrderFill(
        symbol,
        orderId,
        this._fillTimeoutMs,
        this._fillPollMs,
      );
      return { ok: true, data: filled };
    } catch (err) {
      console.warn(
        `⚠️  [${clientOrderPrefix}] waitForOrderFill timeout/error: ${err.message}. Re-checking via getOrder...`,
      );

      // Таймстемп ошибка — записываем в global breaker
      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(err.message);
      }

      // Доп. проверки
      for (let attempt = 1; attempt <= this._postTimeoutRetries; attempt++) {
        await this._sleep(this._postTimeoutRetryDelayMs);
        try {
          const check = await this.binanceClient.getOrder(symbol, orderId);
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
            return {
              ok: false,
              reason: `order_${String(check.status).toLowerCase()}`,
            };
          }
          // NEW / PARTIALLY_FILLED → ещё ждём
        } catch (checkErr) {
          console.warn(
            `   ⚠️  post-timeout getOrder attempt ${attempt} failed: ${checkErr.message}`,
          );
          if (this._isTimestampError(checkErr)) {
            this._recordGlobalTimestampFailure(checkErr.message);
          }
        }
      }

      return {
        ok: false,
        reason: `Order fill unconfirmed after ${this._postTimeoutRetries} retries: ${err.message}`,
      };
    }
  }

  // ─── FAILURE HANDLING / EMERGENCY CLOSE ─────────────────────────

  /**
   * [PROTECT #3] Безопасная обработка провала открытия:
   *   1. verify через getPositions() — что реально есть на бирже
   *   2. если позиция ≠ 0 → closeMarketOrder (жёстко reduceOnly)
   *   3. повторная verify после закрытия
   *
   * Не кидает — всё логирует. Если close не удался, просит ручного вмешательства.
   */
  async _handleOpenFailure(symbol, failReason) {
    console.warn(
      `🔎 [SAFETY] Verifying exchange state for ${symbol} after: ${failReason}`,
    );

    let positions;
    try {
      await this._sleep(500);
      positions = await this.binanceClient.getPositions();
    } catch (err) {
      console.error(
        `❌ [SAFETY] Cannot verify positions: ${err.message}. CANNOT safely emergency-close. Manual check required.`,
      );
      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(err.message);
      }
      return;
    }

    const openPos = positions.find(
      (p) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0,
    );

    if (!openPos) {
      console.log(
        `   ✅ [SAFETY] No position on exchange for ${symbol} — nothing to close.`,
      );
      return;
    }

    const amt = parseFloat(openPos.positionAmt);
    const qty = Math.abs(amt);
    const posSide = amt > 0 ? "LONG" : "SHORT";
    const closeSide = posSide === "LONG" ? "SELL" : "BUY";

    console.warn(
      `🚨 [SAFETY] Stray position on exchange: ${symbol} ${posSide} ${qty}. Emergency closing with reduceOnly...`,
    );

    await this._safeEmergencyClose(symbol, closeSide, qty);
  }

  /**
   * Закрытие через closeMarketOrder (reduceOnly hardcoded в клиенте).
   * После попытки — повторно verify позиции. Логирует результат явно.
   */
  async _safeEmergencyClose(symbol, closeSide, quantity) {
    try {
      await this.binanceClient.closeMarketOrder({
        symbol,
        side: closeSide,
        quantity,
        clientOrderId: `EMERGENCY_${Date.now()}`,
      });
      console.warn(
        `   ✅ [SAFETY] Close order sent: ${symbol} ${closeSide} ${quantity}`,
      );
    } catch (err) {
      console.error(
        `   ❌ [SAFETY] closeMarketOrder failed: ${err.message}. Manual intervention required!`,
      );
      if (this._isTimestampError(err)) {
        this._recordGlobalTimestampFailure(err.message);
      }
      return;
    }

    // Post-close verify
    try {
      await this._sleep(800);
      const positions = await this.binanceClient.getPositions();
      const stillOpen = positions.find(
        (p) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0,
      );
      if (stillOpen) {
        console.error(
          `   ❌ [SAFETY] Position STILL on exchange after close: amt=${stillOpen.positionAmt}. Manual intervention required!`,
        );
      } else {
        console.log(
          `   ✅ [SAFETY] Post-close verify OK: ${symbol} is flat on exchange.`,
        );
      }
    } catch (err) {
      console.warn(
        `   ⚠️  [SAFETY] Post-close verify failed: ${err.message}. Please check manually.`,
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
   * [FIX #4] closeMarketOrder — гарантированный reduceOnly=true в клиенте.
   * [PROTECT #3] post-verify через getPositions.
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
      await this.binanceClient.cancelAllOrders(position.symbol).catch((err) => {
        console.warn(`⚠️  cancelAllOrders: ${err.message}`);
      });

      const closeSide = position.side === "LONG" ? "SELL" : "BUY";
      const closeOrder = await this.binanceClient.closeMarketOrder({
        symbol: position.symbol,
        side: closeSide,
        quantity: position.positionSize,
        clientOrderId: `CLOSE_${Date.now()}`,
      });

      const fillRes = await this._waitForFillWithVerify(
        position.symbol,
        closeOrder.orderId,
        "CLOSE",
      );

      if (!fillRes.ok) {
        console.error(
          `❌ closeLive: fill not confirmed. Running post-close verify...`,
        );
        // Проверим что позиция реально закрыта
        try {
          await this._sleep(800);
          const positions = await this.binanceClient.getPositions();
          const stillOpen = positions.find(
            (p) =>
              p.symbol === position.symbol &&
              Math.abs(parseFloat(p.positionAmt)) > 0,
          );
          if (!stillOpen) {
            console.log(
              `   ✅ Position actually closed on exchange despite unconfirmed fill.`,
            );
            // Закроем в базе по последней известной цене
            const exitPrice =
              parseFloat(fillRes.data?.avgPrice) ||
              parseFloat(
                (await this.binanceClient.getPrice(position.symbol))?.price,
              ) ||
              position.entry;
            return await this._finalizeLiveClose(
              positionId,
              position,
              exitPrice,
              exitReason,
            );
          }
          console.error(
            `   ❌ Position STILL on exchange. Manual check required.`,
          );
          return null;
        } catch (e) {
          console.error(`   ❌ Post-close verify failed: ${e.message}`);
          return null;
        }
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
