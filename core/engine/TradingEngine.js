/**
 * TradingEngine — главный оркестратор торгового цикла.
 *
 * ПОЛНЫЙ ЦИКЛ:
 *   0. Мониторинг открытых позиций (checkAll → закрытие по SL/TP)
 *   1. Сборка контекста (ContextBuilder → MarketLoader → провайдеры)
 *   2. Запуск всех стратегий (StrategyManager)
 *   3. Выбор лучшего сигнала (SignalAggregator)
 *   4. Применение риск-менеджмента (RiskManager)
 *   5. Исполнение (ExecutionService)
 */
export class TradingEngine {
  constructor({
    contextBuilder,
    strategyManager,
    signalAggregator,
    riskManager,
    executionService,
    positionMonitor = null, // опционально — для paper/live mode
  }) {
    if (!contextBuilder)
      throw new Error("TradingEngine: contextBuilder required");
    if (!strategyManager)
      throw new Error("TradingEngine: strategyManager required");
    if (!signalAggregator)
      throw new Error("TradingEngine: signalAggregator required");
    if (!riskManager) throw new Error("TradingEngine: riskManager required");
    if (!executionService)
      throw new Error("TradingEngine: executionService required");

    this.contextBuilder = contextBuilder;
    this.strategyManager = strategyManager;
    this.signalAggregator = signalAggregator;
    this.riskManager = riskManager;
    this.executionService = executionService;
    this.positionMonitor = positionMonitor;
  }

  async run({ symbol }) {
    const startTime = Date.now();

    console.log("\n" + "═".repeat(70));
    console.log(
      `🤖 TradingEngine cycle: ${symbol} | ${new Date().toISOString()}`,
    );
    console.log("═".repeat(70));

    try {
      // ─── PHASE 0: MONITOR OPEN POSITIONS ──────────────────────
      if (this.positionMonitor) {
        const closed = await this.positionMonitor.checkAll(symbol);
        if (closed.length > 0) {
          console.log(`\n🔄 Closed ${closed.length} position(s) by SL/TP`);
        }
      }

      // ─── PHASE 1: BUILD CONTEXT ───────────────────────────────
      const context = await this.contextBuilder.build({ symbol });

      console.log(
        `\n📊 Market: ${context.marketRegime} | HTF: ${context.htfTrend}`,
      );
      console.log(
        `   Price: ${context.price?.toFixed(2)} | Volume: ${context.volumeRatio.toFixed(2)}x`,
      );
      console.log(`   Balance: $${context.balances.futures.toFixed(2)}`);
      console.log(`   Open positions: ${context.positions.open.length}`);

      // ─── PHASE 2: GENERATE SIGNALS ────────────────────────────
      const signals = await this.strategyManager.run(context);

      console.log(`\n📡 Strategy signals (${signals.length}):`);
      signals.forEach((s) => {
        const conf = (s.confidence ?? 0).toFixed(2);
        console.log(
          `   ${s.strategyName}: ${s.type} (conf:${conf}) — ${s.reason}`,
        );
      });

      if (signals.length === 0) {
        return this._finish(
          startTime,
          "no_signals",
          "No strategies returned signals",
        );
      }

      // ─── PHASE 3: PICK BEST SIGNAL ────────────────────────────
      const finalSignal = this.signalAggregator.pick(signals);

      if (!finalSignal) {
        return this._finish(startTime, "all_hold", "All signals are HOLD");
      }

      console.log(
        `\n🎯 Selected: ${finalSignal.strategyName} → ${finalSignal.type}`,
      );

      // ─── PHASE 4: APPLY RISK ──────────────────────────────────
      const riskedSignal = this.riskManager.apply(finalSignal, context);

      if (!riskedSignal.allowed) {
        console.log(`\n⛔ Risk blocked: ${riskedSignal.reason}`);
        return this._finish(startTime, "risk_blocked", riskedSignal.reason);
      }

      console.log(`\n✅ Risk approved`);
      console.log(
        `   Position size: ${riskedSignal.positionSize.toFixed(6)} BTC`,
      );
      console.log(
        `   Notional:      $${riskedSignal.positionNotional.toFixed(2)}`,
      );
      console.log(
        `   Margin:        $${riskedSignal.requiredMargin.toFixed(2)}`,
      );
      console.log(`   Risk amount:   $${riskedSignal.riskAmount.toFixed(2)}`);

      // ─── PHASE 5: EXECUTE ─────────────────────────────────────
      const result = await this.executionService.execute(riskedSignal);

      return this._finish(
        startTime,
        result.ok ? "executed" : "execution_failed",
        result.ok ? "Order executed" : result.reason,
        { result, signal: riskedSignal },
      );
    } catch (err) {
      console.error(`\n❌ TradingEngine error:`, err.message);
      if (process.env.NODE_ENV === "development") console.error(err.stack);
      return this._finish(startTime, "error", err.message);
    }
  }

  _finish(startTime, status, reason, extra = {}) {
    const elapsed = Date.now() - startTime;

    console.log(`\n📋 Cycle result: ${status.toUpperCase()}`);
    if (reason) console.log(`   ${reason}`);
    console.log(`   Took ${elapsed}ms`);
    console.log("═".repeat(70));

    return { status, reason, elapsed, ...extra };
  }
}
