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
 * Защиты:
 *   - Если polling упал — проверяем getPositions() и emergency close (reduceOnly)
 *   - Если главный catch — тоже проверяем getPositions() и emergency close
 */
export class ExecutionService {
  constructor({
    mode = "paper",
    positionStore = null,
    binanceClient = null,
    symbolInfoCache = null,
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
  }

  async _getSymbolInfo(symbol) {
    if (this._symbolInfoCache.has(symbol)) {
      return this._symbolInfoCache.get(symbol);
    }
    const info = await this.binanceClient.getSymbolInfo(symbol);
    this._symbolInfoCache.set(symbol, info);
    return info;
  }

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
        `   Qty: ${quantity} BTC | Notional: ~$${(quantity * signal.entry).toFixed(2)}`,
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

      // 7. ДОЖДАТЬСЯ FILL через polling
      let filledOrder;
      try {
        filledOrder = await this.binanceClient.waitForOrderFill(
          symbol,
          orderId,
          8000,
          300,
        );
      } catch (err) {
        console.error(`❌ Order fill wait failed: ${err.message}`);

        await new Promise((r) => setTimeout(r, 500));
        try {
          const positions = await this.binanceClient.getPositions();
          const openPos = positions.find((p) => p.symbol === symbol);

          if (openPos && Math.abs(openPos.positionAmt) > 0) {
            console.error(
              `🚨 Position exists despite error, emergency closing...`,
            );
            const closeSide = openPos.side === "LONG" ? "SELL" : "BUY";
            await this._emergencyClose(
              symbol,
              closeSide,
              Math.abs(openPos.positionAmt),
            );
          }
        } catch (checkErr) {
          console.error(
            `❌ Failed to check stray position: ${checkErr.message}`,
          );
        }

        return { ok: false, reason: `Order fill failed: ${err.message}` };
      }

      const executedQty = parseFloat(filledOrder.executedQty);
      const avgPrice = parseFloat(filledOrder.avgPrice);

      if (executedQty === 0 || !avgPrice || avgPrice === 0) {
        console.error(
          `❌ Filled order has invalid data: ${JSON.stringify(filledOrder)}`,
        );
        try {
          const positions = await this.binanceClient.getPositions();
          const openPos = positions.find((p) => p.symbol === symbol);
          if (openPos && Math.abs(openPos.positionAmt) > 0) {
            const closeSide = openPos.side === "LONG" ? "SELL" : "BUY";
            await this._emergencyClose(
              symbol,
              closeSide,
              Math.abs(openPos.positionAmt),
            );
          }
        } catch (e) {
          console.error(`❌ Safety check failed: ${e.message}`);
        }
        return { ok: false, reason: `Invalid fill data` };
      }

      console.log(
        `✅ [${clientOrderPrefix}] MARKET исполнен: ${executedQty} BTC @ ${avgPrice}`,
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
      console.log(
        `   ${symbol} ${domainSide} ${executedQty} BTC @ ${avgPrice}`,
      );
      console.log(`   SL: ${finalSL} | TP: ${finalTP}`);
      console.log(`   Strategy: ${signal.strategyName}`);
      console.log("─".repeat(60));

      return {
        ok: true,
        mode: "live",
        position,
        order: filledOrder,
        slOrderId: null,
        tpOrderId: null,
      };
    } catch (err) {
      console.error(`\n❌ _executeLive failed: ${err.message}`);
      console.error(err.stack);

      try {
        await new Promise((r) => setTimeout(r, 500));
        const positions = await this.binanceClient.getPositions();
        const openPos = positions.find((p) => p.symbol === symbol);
        if (openPos && Math.abs(openPos.positionAmt) > 0) {
          console.error(`🚨 Stray position detected, emergency closing...`);
          const closeSide = openPos.side === "LONG" ? "SELL" : "BUY";
          await this._emergencyClose(
            symbol,
            closeSide,
            Math.abs(openPos.positionAmt),
          );
        }
      } catch (checkErr) {
        console.error(`❌ Failed to check stray position: ${checkErr.message}`);
      }

      return { ok: false, reason: `Exchange error: ${err.message}` };
    }
  }

  /**
   * Экстренно закрыть позицию без SL/TP.
   * [FIX #4] reduceOnly=true — гарантия, что не переворачиваем позицию.
   */
  async _emergencyClose(symbol, closeSide, quantity) {
    try {
      console.warn(`⚠️  EMERGENCY CLOSE ${symbol} ${closeSide} ${quantity}`);
      await this.binanceClient.placeMarketOrder({
        symbol,
        side: closeSide,
        quantity,
        clientOrderId: `EMERGENCY_${Date.now()}`,
        reduceOnly: true,
      });
      console.warn(`✅ Emergency close done`);
    } catch (err) {
      console.error(`❌ CRITICAL: emergency close failed: ${err.message}`);
      console.error(
        `   Position REMAINS OPEN on exchange! Manual intervention required.`,
      );
    }
  }

  /**
   * Закрыть paper-позицию.
   */
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

  /**
   * Закрыть live-позицию вручную.
   * [FIX #4] reduceOnly=true — гарантия, что не переворачиваем позицию.
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
      const closeOrder = await this.binanceClient.placeMarketOrder({
        symbol: position.symbol,
        side: closeSide,
        quantity: position.positionSize,
        clientOrderId: `CLOSE_${Date.now()}`,
        reduceOnly: true,
      });

      const filled = await this.binanceClient.waitForOrderFill(
        position.symbol,
        closeOrder.orderId,
        8000,
        300,
      );

      const exitPrice = parseFloat(filled.avgPrice);
      const closed = await this.positionStore.close(positionId, {
        exitPrice,
        exitReason,
      });

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
    } catch (err) {
      console.error(`❌ closeLive failed: ${err.message}`);
      return null;
    }
  }
}
