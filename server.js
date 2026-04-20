/**
 * btc-bot-v3 — Modular Trading Platform (LIVE)
 *
 * Server entry point.
 *
 * Две стратегии работают параллельно в одной системе:
 *   1. Breakout 1h — trend following (основной baseline)
 *   2. ML-Only    — торгует только по сигналам ML модели (экспериментальный)
 *
 * Каждая стратегия имеет:
 *   - Свой MongoPositionStore (фильтр по strategyId)
 *   - Свой префикс для clientOrderId (BRK_ и ML_)
 *   - Свою логику размера позиции (ML-Only = фиксированные 0.002 BTC)
 *
 * РЕЖИМЫ (через .env):
 *   TRADING_MODE=paper  → симуляция, позиции в памяти
 *   TRADING_MODE=live   → реальная торговля на Binance
 *
 * Запуск: node server.js
 */

import "dotenv/config";
import { connectMongo, disconnectMongo } from "./app/db/mongo.js";

// Providers
import { BinanceFuturesClient } from "./core/providers/binanceFuturesClient.js";
import { CandleProvider } from "./core/providers/candleProvider.js";
import { IndicatorProvider } from "./core/providers/indicatorProvider.js";
import { AccountProvider } from "./core/providers/accountProvider.js";
import { PositionProvider } from "./core/providers/positionProvider.js";
import { RegimeProvider } from "./core/providers/regimeProvider.js";
import { MarketContextProvider } from "./core/providers/marketContextProvider.js";

// Core modules
import { MarketLoader } from "./core/market/marketLoader.js";
import { MarketDataPoller } from "./core/market/marketDataPoller.js";
import { ContextBuilder } from "./core/context/ContextBuilder.js";
import { StrategyManager } from "./core/strategy/StrategyManager.js";
import { SignalAggregator } from "./core/signal/SignalAggregator.js";
import { RiskManager } from "./core/risk/RiskManager.js";
import { ExecutionService } from "./core/execution/execution.service.js";
import { TradingEngine } from "./core/engine/TradingEngine.js";
import { MongoPositionStore } from "./core/positions/MongoPositionStore.js";
import { PaperPositionStore } from "./core/positions/PaperPositionStore.js";
import { PositionMonitor } from "./core/positions/PositionMonitor.js";

// ML
import { MLClient } from "./core/ml/MLClient.js";

// Strategies
import { BreakoutStrategy } from "./strategies/breakout/breakout.strategy.js";
import { MLOnlyStrategy } from "./strategies/mlOnly/mlOnly.strategy.js";

// ── Configuration ──────────────────────────────────────────────────
const SYMBOL = process.env.TRADING_SYMBOL || "BTCUSDT";
const MODE = process.env.TRADING_MODE || "paper";
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || "60000");
const LEVERAGE = parseInt(process.env.LEVERAGE || "10");

// Cooldown после закрытия позиции (защита от whipsaw-серий).
const COOLDOWN_AFTER_CLOSE_MS = parseInt(
  process.env.COOLDOWN_AFTER_CLOSE_MS || "900000",
);

// Размеры позиций (BTC)
const ML_ONLY_SIZE_BTC = parseFloat(process.env.ML_ONLY_SIZE_BTC || "0.002");

// ML service
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:3001";

// Daily loss limits (USDT)
const BREAKOUT_DAILY_LOSS_LIMIT = parseFloat(
  process.env.BREAKOUT_DAILY_LOSS_LIMIT || "50",
);
const MLONLY_DAILY_LOSS_LIMIT = parseFloat(
  process.env.MLONLY_DAILY_LOSS_LIMIT || "20",
);

// ── [Phase 1 filters] ─────────────────────────────────────────────
// Минимальный confidence для ML-Only стратегии (0.55 по умолчанию).
// Рекомендуемые значения: 0.50 (мягко), 0.55 (умеренно), 0.60 (строго).
const ML_MIN_CONFIDENCE = parseFloat(process.env.ML_MIN_CONFIDENCE || "0.55");

// Что считать "сильным" funding rate в ПРОЦЕНТАХ:
// 0.03 = строго, 0.05 = умеренно (default), 0.08 = мягко.
const FUNDING_THRESHOLD_PCT = parseFloat(
  process.env.FUNDING_THRESHOLD_PCT || "0.05",
);

// Надбавка к порогу confidence для ML-Only, если сигнал ПРОТИВ funding (0.10 = +10%).
const CONTRA_FUNDING_BOOST = parseFloat(
  process.env.CONTRA_FUNDING_BOOST || "0.10",
);

// Надбавка к порогу в "опасные" часы (выходные 20:00-00:00 UTC).
const RISKY_HOUR_BOOST = parseFloat(process.env.RISKY_HOUR_BOOST || "0.10");

// Для Breakout — умножитель порога volRatio (фильтр объёма).
// 0.30 = +30% к minVolumeRatio при contra-funding или risky hour.
const BREAKOUT_CONTRA_FUNDING_VOL_BOOST = parseFloat(
  process.env.BREAKOUT_CONTRA_FUNDING_VOL_BOOST || "0.30",
);
const BREAKOUT_RISKY_HOUR_VOL_BOOST = parseFloat(
  process.env.BREAKOUT_RISKY_HOUR_VOL_BOOST || "0.30",
);

console.log("═".repeat(70));
console.log("🚀 btc-bot-v3 — Modular Trading Platform");
console.log("═".repeat(70));
console.log(`   Symbol:         ${SYMBOL}`);
console.log(`   Mode:           ${MODE.toUpperCase()}`);
console.log(`   Interval:       ${CYCLE_INTERVAL_MS / 1000}s`);
console.log(`   Leverage:       x${LEVERAGE}`);
console.log(`   ML-Only size:   ${ML_ONLY_SIZE_BTC} BTC`);
console.log(`   ML URL:         ${ML_SERVICE_URL}`);
console.log(
  `   Cooldown:       ${COOLDOWN_AFTER_CLOSE_MS === 0 ? "disabled" : Math.round(COOLDOWN_AFTER_CLOSE_MS / 60000) + "min after close"}`,
);
console.log(`   ML minConf:     ${ML_MIN_CONFIDENCE}`);
console.log(`   Funding thr:    ±${FUNDING_THRESHOLD_PCT}%`);
console.log(
  `   Boosts:         contra-funding +${(CONTRA_FUNDING_BOOST * 100).toFixed(0)}% | risky-hour +${(RISKY_HOUR_BOOST * 100).toFixed(0)}%`,
);
console.log("═".repeat(70));

async function bootstrap() {
  // ── 1. Mongo ────────────────────────────────────────────────────
  await connectMongo(process.env.MONGO_URI);

  // ── 2. Binance client (только для live/testnet) ────────────────
  let binanceClient = null;
  if (MODE === "live" || MODE === "testnet") {
    const apiKey = process.env.BINANCE_FUTURES_API_KEY;
    const apiSecret = process.env.BINANCE_FUTURES_SECRET_KEY;

    if (!apiKey || !apiSecret || apiSecret === "0") {
      throw new Error(
        "LIVE mode requires BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_SECRET_KEY in .env",
      );
    }

    binanceClient = new BinanceFuturesClient({
      apiKey,
      apiSecret,
      testnet: MODE === "testnet",
    });

    // Тест подключения — получить баланс
    try {
      const balance = await binanceClient.getBalance();
      console.log(
        `\n💰 Binance balance: ${balance.totalWalletBalance.toFixed(2)} USDT (available: ${balance.availableBalance.toFixed(2)})`,
      );
    } catch (err) {
      throw new Error(`Failed to connect to Binance: ${err.message}`);
    }
  }

  // ── 3. ML Client ────────────────────────────────────────────────
  const mlClient = new MLClient({
    baseUrl: ML_SERVICE_URL,
    timeout: 10000,
  });

  const mlStatus = await mlClient.status();
  if (mlStatus) {
    console.log(
      `\n🧠 ML-Service: ${mlStatus.status}, model: ${mlStatus.model}, lastTrain: ${mlStatus.lastTrainTime ?? "never"}`,
    );
  } else {
    console.warn(`\n⚠️  ML-Service недоступен на ${ML_SERVICE_URL}`);
    console.warn(
      `   ML-Only стратегия будет возвращать HOLD до восстановления`,
    );
  }

  // ── 4. Market Data Poller ───────────────────────────────────────
  let marketDataPoller = null;
  if (MODE === "live" || MODE === "testnet") {
    marketDataPoller = new MarketDataPoller({
      binanceClient,
      symbols: [SYMBOL],
      intervals: ["1h", "4h", "1d"],
    });
  }

  // ── 5. Providers ────────────────────────────────────────────────
  const candleProvider = new CandleProvider();
  const indicatorProvider = new IndicatorProvider();
  const regimeProvider = new RegimeProvider();
  const marketContextProvider = new MarketContextProvider({
    cacheTtlMs: 60_000, // funding/OI обновляются не чаще раза в минуту
  });

  const accountProvider =
    MODE === "live" || MODE === "testnet"
      ? new AccountProvider({ mode: "live", binanceClient, cacheTtlMs: 30_000 })
      : new AccountProvider({ mode: "mock", mockBalance: 144 });

  // ── 6. Position Stores (по одному на стратегию) ─────────────────
  const breakoutStore =
    MODE === "live" || MODE === "testnet"
      ? new MongoPositionStore({ strategyId: "breakout" })
      : new PaperPositionStore();

  const mlOnlyStore =
    MODE === "live" || MODE === "testnet"
      ? new MongoPositionStore({ strategyId: "mlOnly" })
      : new PaperPositionStore();

  // ── 7. Execution Services (по одному на стратегию) ──────────────
  const breakoutExecution = new ExecutionService({
    mode: MODE,
    positionStore: breakoutStore,
    binanceClient,
  });

  const mlOnlyExecution = new ExecutionService({
    mode: MODE,
    positionStore: mlOnlyStore,
    binanceClient,
  });
  const positionMonitor = new PositionMonitor({
    binanceClient,
    breakoutStore,
    mlOnlyStore,
    pollIntervalMs: 5000,
  });

  // ── 8. Strategies ───────────────────────────────────────────────
  const breakoutStrategy = new BreakoutStrategy({
    fundingThresholdPct: FUNDING_THRESHOLD_PCT,
    contraFundingVolBoost: BREAKOUT_CONTRA_FUNDING_VOL_BOOST,
    riskyHourVolBoost: BREAKOUT_RISKY_HOUR_VOL_BOOST,
  });
  const mlOnlyStrategy = new MLOnlyStrategy({
    mlClient,
    minConfidence: ML_MIN_CONFIDENCE,
    atrMultiplierSL: 1.5,
    atrMultiplierTP: 3.0,
    maxHoldCandles: 24,
    fundingThresholdPct: FUNDING_THRESHOLD_PCT,
    contraFundingBoost: CONTRA_FUNDING_BOOST,
    riskyHourBoost: RISKY_HOUR_BOOST,
  });

  console.log(`\n📋 Registered strategies:`);
  console.log(`   1. ${breakoutStrategy.name} (${breakoutStrategy.id})`);
  console.log(
    `   2. ${mlOnlyStrategy.name} (${mlOnlyStrategy.id}) — fixed ${ML_ONLY_SIZE_BTC} BTC`,
  );

  // ── 9. Risk Manager ─────────────────────────────────────────────
  const breakoutRiskManager = new RiskManager({
    riskPerTrade: 0.01,
    minBalance: 10,
    maxPositionPctOfBalance: 5,
    minPositionUSDT: 5,
  });

  // ── 10. Context / Strategy Manager ──────────────────────────────
  const positionProvider = new PositionProvider({
    mode: MODE === "paper" ? "paper" : "mongo",
    store: breakoutStore,
  });

  const marketLoader = new MarketLoader({
    candleProvider,
    indicatorProvider,
    accountProvider,
    positionProvider,
    regimeProvider,
    marketContextProvider, // ← новое, Phase 1
  });

  const contextBuilder = new ContextBuilder({
    marketLoader,
    mlClient,
    strategies: [breakoutStrategy, mlOnlyStrategy],
  });

  // ── 11. Daily stats (для daily loss limit) ─────────────────────
  const dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    breakoutPnL: 0,
    mlOnlyPnL: 0,
  };

  const resetDailyStatsIfNewDay = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyStats.date) {
      console.log(`\n📅 New day: ${today}, resetting daily stats`);
      dailyStats.date = today;
      dailyStats.breakoutPnL = 0;
      dailyStats.mlOnlyPnL = 0;
    }
  };

  const isBreakoutStopped = () =>
    dailyStats.breakoutPnL <= -BREAKOUT_DAILY_LOSS_LIMIT;
  const isMlOnlyStopped = () =>
    dailyStats.mlOnlyPnL <= -MLONLY_DAILY_LOSS_LIMIT;

  // ── 12. Strategy runner ─────────────────────────────────────────
  async function runStrategy({
    strategy,
    store,
    execution,
    ctx,
    clientOrderPrefix,
    fixedSize = null,
  }) {
    const strategyId = strategy.id;

    if (strategyId === "breakout" && isBreakoutStopped()) {
      return { skipped: "daily_loss_limit" };
    }
    if (strategyId === "mlOnly" && isMlOnlyStopped()) {
      return { skipped: "daily_loss_limit" };
    }

    const openPositions = await store.getOpenPositions();
    if (openPositions.length > 0) {
      return { skipped: "already_has_open_position" };
    }

    // Cooldown после закрытия последней позиции
    if (COOLDOWN_AFTER_CLOSE_MS > 0) {
      const lastClosed = await store.getLastClosedPosition();
      if (lastClosed?.closedAt) {
        const sinceCloseMs =
          Date.now() - new Date(lastClosed.closedAt).getTime();
        if (sinceCloseMs < COOLDOWN_AFTER_CLOSE_MS) {
          const remainingSec = Math.ceil(
            (COOLDOWN_AFTER_CLOSE_MS - sinceCloseMs) / 1000,
          );
          const remainingLabel =
            remainingSec >= 60
              ? `${Math.ceil(remainingSec / 60)}min`
              : `${remainingSec}s`;
          return {
            skipped: `cooldown_${remainingLabel}_after_${lastClosed.exitReason ?? "close"}`,
          };
        }
      }
    }

    const signal = await strategy.generateSignal(ctx);
    if (signal.type === "HOLD") {
      return { action: "HOLD", reason: signal.reason };
    }

    let riskedSignal;
    if (fixedSize !== null) {
      const positionSize = fixedSize;
      const notional = positionSize * signal.entry;
      const requiredMargin = notional / LEVERAGE;

      riskedSignal = {
        ...signal,
        allowed: true,
        positionSize,
        positionNotional: notional,
        requiredMargin,
        leverage: LEVERAGE,
      };
    } else {
      const balances = await accountProvider.getBalances();
      const plan = breakoutRiskManager.buildPlan({
        signal,
        balance: balances.futures,
        leverage: LEVERAGE,
      });

      if (!plan.allowed) {
        return { action: "REJECTED", reason: plan.reason };
      }

      riskedSignal = {
        ...signal,
        ...plan,
      };
    }

    const result = await execution.execute(riskedSignal, { clientOrderPrefix });

    if (!result.ok) {
      console.warn(`\n⚠️  [${strategyId}] Execution failed: ${result.reason}`);
      return { action: "FAILED", reason: result.reason };
    }

    return { action: "OPENED", position: result.position };
  }

  // ── 13. Main cycle ──────────────────────────────────────────────
  let cycleCount = 0;
  let isRunning = false;

  const runCycle = async () => {
    if (isRunning) {
      console.log("⏳ Previous cycle still running, skipping");
      return;
    }
    isRunning = true;
    cycleCount++;
    const startTime = Date.now();

    console.log(`\n\n┏━━ CYCLE #${cycleCount} ${"━".repeat(50)}`);
    console.log(`   ${new Date().toISOString()}`);

    try {
      resetDailyStatsIfNewDay();

      if (marketDataPoller) {
        await marketDataPoller.sync();
      }

      const ctx = await contextBuilder.build({ symbol: SYMBOL });

      if (!ctx) {
        console.warn("⚠️  Failed to build context, skipping cycle");
        return;
      }

      // Компактный лог контекстных условий (funding/time)
      const fr = ctx.marketContext?.funding;
      const tc = ctx.marketContext?.time;
      if (fr || tc) {
        const parts = [];
        if (fr) parts.push(`funding ${fr.ratePct.toFixed(3)}%`);
        if (tc?.isRiskyHour) parts.push(`⚠️ risky_hour (${tc.reason})`);
        if (parts.length > 0) {
          console.log(`🌐 Context: ${parts.join(" | ")}`);
        }
      }

      // Прогнать Breakout
      console.log(`\n🔹 Breakout 1h:`);
      const breakoutResult = await runStrategy({
        strategy: breakoutStrategy,
        store: breakoutStore,
        execution: breakoutExecution,
        ctx,
        clientOrderPrefix: "BRK",
        fixedSize: null,
      });
      console.log(`   ${JSON.stringify(breakoutResult)}`);

      // Прогнать ML-Only
      console.log(`\n🔸 ML-Only:`);
      const mlResult = await runStrategy({
        strategy: mlOnlyStrategy,
        store: mlOnlyStore,
        execution: mlOnlyExecution,
        ctx,
        clientOrderPrefix: "ML",
        fixedSize: ML_ONLY_SIZE_BTC,
      });
      console.log(`   ${JSON.stringify(mlResult)}`);

      const breakoutStats = await breakoutStore.getStats();
      const mlStats = await mlOnlyStore.getStats();

      console.log(`\n📊 Stats:`);
      console.log(
        `   Breakout: ${breakoutStats.totalTrades} trades | WR ${breakoutStats.winRate.toFixed(0)}% | PF ${breakoutStats.profitFactor.toFixed(2)} | PnL $${breakoutStats.totalPnL.toFixed(2)} | Open: ${breakoutStats.openPositions}`,
      );
      console.log(
        `   ML-Only:  ${mlStats.totalTrades} trades | WR ${mlStats.winRate.toFixed(0)}% | PF ${mlStats.profitFactor.toFixed(2)} | PnL $${mlStats.totalPnL.toFixed(2)} | Open: ${mlStats.openPositions}`,
      );
      console.log(
        `   Today:    Breakout $${dailyStats.breakoutPnL.toFixed(2)} | ML-Only $${dailyStats.mlOnlyPnL.toFixed(2)}`,
      );
    } catch (err) {
      console.error(`\n❌ Cycle error: ${err.message}`);
      console.error(err.stack);
    } finally {
      isRunning = false;
      const duration = Date.now() - startTime;
      console.log(
        `┗━━ Cycle #${cycleCount} done in ${duration}ms ${"━".repeat(40)}\n`,
      );
    }
  };

  await runCycle();
  if (MODE === "live" || MODE === "testnet") {
    positionMonitor.start();
  }
  const interval = setInterval(runCycle, CYCLE_INTERVAL_MS);

  const shutdown = async (signal) => {
    console.log(`\n\n🛑 ${signal} received, shutting down...`);
    clearInterval(interval);

    let waited = 0;
    while (isRunning && waited < 10000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }

    if (MODE === "live" || MODE === "testnet") {
      const breakoutOpen = await breakoutStore.getOpenPositions();
      const mlOpen = await mlOnlyStore.getOpenPositions();

      if (breakoutOpen.length > 0 || mlOpen.length > 0) {
        console.log(`\n⚠️  Open positions remain on exchange:`);
        for (const p of breakoutOpen) {
          console.log(
            `   Breakout: ${p.side} ${p.symbol} @ ${p.entry} (SL ${p.stopLoss})`,
          );
        }
        for (const p of mlOpen) {
          console.log(
            `   ML-Only:  ${p.side} ${p.symbol} @ ${p.entry} (SL ${p.stopLoss})`,
          );
        }
        console.log(`   They will be managed by SL/TP orders on Binance.`);
      }
    }

    console.log("\n" + "═".repeat(70));
    console.log("FINAL STATS");
    console.log("═".repeat(70));

    const breakoutStats = await breakoutStore.getStats();
    const mlStats = await mlOnlyStore.getStats();

    console.log(`   Total cycles: ${cycleCount}`);
    console.log(
      `   Breakout:     ${breakoutStats.totalTrades} trades, WR ${breakoutStats.winRate.toFixed(0)}%, PnL $${breakoutStats.totalPnL.toFixed(2)}`,
    );
    console.log(
      `   ML-Only:      ${mlStats.totalTrades} trades, WR ${mlStats.winRate.toFixed(0)}%, PnL $${mlStats.totalPnL.toFixed(2)}`,
    );
    console.log("═".repeat(70));
    positionMonitor.stop();
    await disconnectMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch(async (err) => {
  console.error("\n❌ Bootstrap failed:", err);
  console.error(err.stack);
  await disconnectMongo();
  process.exit(1);
});
