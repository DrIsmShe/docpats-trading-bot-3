/**
 * btc-bot-v3 — Modular Trading Platform (LIVE)
 *
 * Server entry point.
 *
 * Две стратегии работают параллельно на РАЗНЫХ символах:
 *   1. Breakout 1h — trend following (ETHUSDT по умолчанию, БЕЗ ML)
 *   2. ML-Only    — нейросеть (BTCUSDT — ML обучена на BTC)
 *
 * Такое распределение полностью исключает конфликт стратегий:
 *   - Нет ситуации "одна даёт LONG, вторая SHORT на одном символе"
 *   - Binance держит их как 2 независимые позиции (разные символы)
 *   - ML-модель используется только на BTC (на котором обучена)
 *
 * [ML SCOPE] ML-контекст собирается ТОЛЬКО для MLONLY_SYMBOL (BTC).
 * Для BREAKOUT_SYMBOL (ETH) контекст строится с skipML=true — стратегия
 * Breakout ML не использует, а модель для ETH не обучена, так что
 * бесполезные /predict запросы только спамили бы error.log.
 *
 * Каждая стратегия имеет:
 *   - Свой символ (через .env: BREAKOUT_SYMBOL, MLONLY_SYMBOL)
 *   - Свой MongoPositionStore (фильтр по strategyId)
 *   - Свой префикс для clientOrderId (BRK_ и ML_)
 *
 * РЕЖИМЫ (через .env):
 *   TRADING_MODE=paper  → симуляция, позиции в памяти
 *   TRADING_MODE=live   → реальная торговля на Binance
 *
 * [GAP #2] При старте в live/testnet режиме выполняется reconcile состояния:
 *   сверка открытых позиций в БД с реальным состоянием на бирже.
 *   Это защита от рассинхрона после падений/рестартов.
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
import { RiskManager } from "./core/risk/RiskManager.js";
import { ExecutionService } from "./core/execution/execution.service.js";
import { MongoPositionStore } from "./core/positions/MongoPositionStore.js";
import { PaperPositionStore } from "./core/positions/PaperPositionStore.js";
import { PositionMonitor } from "./core/positions/PositionMonitor.js";

// ML
import { MLClient } from "./core/ml/MLClient.js";

// Strategies
import { BreakoutStrategy } from "./strategies/breakout/breakout.strategy.js";
import { MLOnlyStrategy } from "./strategies/mlOnly/mlOnly.strategy.js";

// ── Configuration ──────────────────────────────────────────────────
const MODE = process.env.TRADING_MODE || "paper";
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || "60000");
const LEVERAGE = parseInt(process.env.LEVERAGE || "10");

// [MULTI-SYMBOL] Разные символы для разных стратегий.
// Breakout на ETH (без ML), ML-Only на BTC (модель натренирована на BTC).
const BREAKOUT_SYMBOL = process.env.BREAKOUT_SYMBOL || "ETHUSDT";
const MLONLY_SYMBOL = process.env.MLONLY_SYMBOL || "BTCUSDT";

// Cooldown после закрытия позиции
const COOLDOWN_AFTER_CLOSE_MS = parseInt(
  process.env.COOLDOWN_AFTER_CLOSE_MS || "900000",
);

// Размер позиции ML-Only в базовом активе (BTC)
const ML_ONLY_SIZE_BTC = parseFloat(process.env.ML_ONLY_SIZE_BTC || "0.002");

// ML service
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:3001";

// Daily loss limits
const BREAKOUT_DAILY_LOSS_LIMIT = parseFloat(
  process.env.BREAKOUT_DAILY_LOSS_LIMIT || "50",
);
const MLONLY_DAILY_LOSS_LIMIT = parseFloat(
  process.env.MLONLY_DAILY_LOSS_LIMIT || "20",
);

// Phase 1 filters
const ML_MIN_CONFIDENCE = parseFloat(process.env.ML_MIN_CONFIDENCE || "0.55");
const FUNDING_THRESHOLD_PCT = parseFloat(
  process.env.FUNDING_THRESHOLD_PCT || "0.05",
);
const CONTRA_FUNDING_BOOST = parseFloat(
  process.env.CONTRA_FUNDING_BOOST || "0.10",
);
const RISKY_HOUR_BOOST = parseFloat(process.env.RISKY_HOUR_BOOST || "0.10");
const BREAKOUT_CONTRA_FUNDING_VOL_BOOST = parseFloat(
  process.env.BREAKOUT_CONTRA_FUNDING_VOL_BOOST || "0.30",
);
const BREAKOUT_RISKY_HOUR_VOL_BOOST = parseFloat(
  process.env.BREAKOUT_RISKY_HOUR_VOL_BOOST || "0.30",
);

// [ETH] Breakout настроен строже для ETH по умолчанию:
// minVolatilityPct 0.30 (вместо 0.18), т.к. ETH ATR% обычно выше.
// Переопределяется через .env: BREAKOUT_MIN_VOLATILITY_PCT
const BREAKOUT_MIN_VOLATILITY_PCT = parseFloat(
  process.env.BREAKOUT_MIN_VOLATILITY_PCT || "0.30",
);

console.log("═".repeat(70));
console.log("🚀 btc-bot-v3 — Modular Trading Platform (Multi-Symbol)");
console.log("═".repeat(70));
console.log(`   Mode:           ${MODE.toUpperCase()}`);
console.log(`   Interval:       ${CYCLE_INTERVAL_MS / 1000}s`);
console.log(`   Leverage:       x${LEVERAGE}`);
console.log(`   Breakout pair:  ${BREAKOUT_SYMBOL} (no ML)`);
console.log(`   ML-Only pair:   ${MLONLY_SYMBOL} (fixed ${ML_ONLY_SIZE_BTC})`);
console.log(`   ML URL:         ${ML_SERVICE_URL}`);
console.log(
  `   Cooldown:       ${COOLDOWN_AFTER_CLOSE_MS === 0 ? "disabled" : Math.round(COOLDOWN_AFTER_CLOSE_MS / 60000) + "min after close"}`,
);
console.log(`   ML minConf:     ${ML_MIN_CONFIDENCE}`);
console.log(`   Funding thr:    ±${FUNDING_THRESHOLD_PCT}%`);
console.log(
  `   Boosts:         contra-funding +${(CONTRA_FUNDING_BOOST * 100).toFixed(0)}% | risky-hour +${(RISKY_HOUR_BOOST * 100).toFixed(0)}%`,
);
console.log(
  `   Breakout ATR%:  ${BREAKOUT_MIN_VOLATILITY_PCT} min (ETH-adapted)`,
);
console.log("═".repeat(70));

async function bootstrap() {
  // ── 1. Mongo ────────────────────────────────────────────────────
  await connectMongo(process.env.MONGO_URI);

  // ── 2. Binance client ───────────────────────────────────────────
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
  }

  // ── 4. Market Data Poller — качает свечи для ОБОИХ символов ─────
  // Уникальные символы (на случай если BREAKOUT_SYMBOL === MLONLY_SYMBOL)
  const allSymbols = [...new Set([BREAKOUT_SYMBOL, MLONLY_SYMBOL])];
  let marketDataPoller = null;
  if (MODE === "live" || MODE === "testnet") {
    marketDataPoller = new MarketDataPoller({
      binanceClient,
      symbols: allSymbols,
      intervals: ["1h", "4h", "1d"],
    });
    console.log(`\n📥 MarketDataPoller: symbols=[${allSymbols.join(", ")}]`);
  }

  // ── 5. Providers (shared между стратегиями) ─────────────────────
  const candleProvider = new CandleProvider();
  const indicatorProvider = new IndicatorProvider();
  const regimeProvider = new RegimeProvider();
  const marketContextProvider = new MarketContextProvider({
    cacheTtlMs: 60_000,
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

  // ── 7. Execution Services ───────────────────────────────────────
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
    minVolatilityPct: BREAKOUT_MIN_VOLATILITY_PCT,
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
  console.log(
    `   1. ${breakoutStrategy.name} (${breakoutStrategy.id}) → ${BREAKOUT_SYMBOL} (no ML)`,
  );
  console.log(
    `   2. ${mlOnlyStrategy.name} (${mlOnlyStrategy.id}) → ${MLONLY_SYMBOL} fixed ${ML_ONLY_SIZE_BTC}`,
  );

  // ── 9. Risk Manager ─────────────────────────────────────────────
  const breakoutRiskManager = new RiskManager({
    riskPerTrade: 0.01,
    minBalance: 10,
    maxPositionPctOfBalance: 5,
    minPositionUSDT: 5,
  });

  // ── 10. Position provider + per-symbol ContextBuilder ───────────
  //
  // ВАЖНО: ContextBuilder принимает symbol в build(), поэтому один инстанс
  // подходит для обоих символов. PositionProvider тоже вызывается с
  // симовлом при запросе открытых позиций.

  const positionProvider = new PositionProvider({
    mode: MODE === "paper" ? "paper" : "mongo",
    store: breakoutStore, // для контекста достаточно одного; каждая стратегия всё равно использует свой store
  });

  const marketLoader = new MarketLoader({
    candleProvider,
    indicatorProvider,
    accountProvider,
    positionProvider,
    regimeProvider,
    marketContextProvider,
  });

  const contextBuilder = new ContextBuilder({
    marketLoader,
    mlClient,
    strategies: [breakoutStrategy, mlOnlyStrategy],
  });

  // ── 11. Daily stats ─────────────────────────────────────────────
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

    // Cooldown
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
      // ML-Only: фиксированный размер (в базовом активе)
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
      // Breakout: риск-менеджер по балансу
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

      // 1. Подкачать свежие свечи (для всех символов сразу)
      if (marketDataPoller) {
        await marketDataPoller.sync();
      }

      // 2. Построить ДВА контекста: для BTC и для ETH параллельно.
      //    ETH-контекст собирается с skipML=true, т.к. модель на ETH
      //    не обучена, а Breakout стратегия ML не использует.
      const [ctxML, ctxBreakout] = await Promise.all([
        contextBuilder.build({ symbol: MLONLY_SYMBOL }),
        contextBuilder.build({ symbol: BREAKOUT_SYMBOL, skipML: true }),
      ]);

      if (!ctxML || !ctxBreakout) {
        console.warn("⚠️  Failed to build one of contexts, skipping cycle");
        return;
      }

      // 3. Компактный лог контекстных условий
      const logCtxSummary = (tag, ctx) => {
        const fr = ctx.marketContext?.funding;
        const tc = ctx.marketContext?.time;
        const parts = [`price ${ctx.price?.toFixed(2)}`];
        if (fr) parts.push(`funding ${fr.ratePct.toFixed(3)}%`);
        if (tc?.isRiskyHour) parts.push(`⚠️risky(${tc.reason})`);
        console.log(`🌐 [${tag}] ${parts.join(" | ")}`);
      };
      logCtxSummary(MLONLY_SYMBOL, ctxML);
      logCtxSummary(BREAKOUT_SYMBOL, ctxBreakout);

      // 4. Прогнать Breakout (на ETH, без ML)
      console.log(`\n🔹 Breakout 1h [${BREAKOUT_SYMBOL}]:`);
      const breakoutResult = await runStrategy({
        strategy: breakoutStrategy,
        store: breakoutStore,
        execution: breakoutExecution,
        ctx: ctxBreakout,
        clientOrderPrefix: "BRK",
        fixedSize: null,
      });
      console.log(`   ${JSON.stringify(breakoutResult)}`);

      // 5. Прогнать ML-Only (на BTC)
      console.log(`\n🔸 ML-Only [${MLONLY_SYMBOL}]:`);
      const mlResult = await runStrategy({
        strategy: mlOnlyStrategy,
        store: mlOnlyStore,
        execution: mlOnlyExecution,
        ctx: ctxML,
        clientOrderPrefix: "ML",
        fixedSize: ML_ONLY_SIZE_BTC,
      });
      console.log(`   ${JSON.stringify(mlResult)}`);

      // 6. Статистика
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

  // ── 13.5. [GAP #2] Startup reconcile ────────────────────────────
  //
  // КРИТИЧНО: сверка БД↔биржа ДО первого runCycle.
  //
  // Если бот упал между placeMarketOrder и store.close() на прошлом запуске:
  //   - На бирже: позиция уже закрыта
  //   - В БД:    позиция всё ещё OPEN
  // Без reconcile runCycle увидит "already_has_open_position" и не откроет
  // новую, а PositionMonitor будет циклически пытаться её закрывать
  // (reduceOnly reject).
  //
  // Обратный кейс (позиция на бирже есть, в БД нет) — Telegram-алерт,
  // НЕ закрываем автоматически, т.к. не знаем SL/TP/entry.
  if (MODE === "live" || MODE === "testnet") {
    try {
      await positionMonitor.reconcileOnStartup();
    } catch (err) {
      console.error(`❌ Startup reconcile failed: ${err.message}`);
      console.error(
        `   Продолжаю bootstrap, но состояние БД↔биржа может быть рассинхронизировано.`,
      );
    }
  }

  // ── 13.6. First cycle + start monitor + interval ────────────────
  await runCycle();
  if (MODE === "live" || MODE === "testnet") {
    positionMonitor.start();
  }
  const interval = setInterval(runCycle, CYCLE_INTERVAL_MS);

  // ── 14. Graceful shutdown ───────────────────────────────────────
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
      `   Breakout (${BREAKOUT_SYMBOL}): ${breakoutStats.totalTrades} trades, WR ${breakoutStats.winRate.toFixed(0)}%, PnL $${breakoutStats.totalPnL.toFixed(2)}`,
    );
    console.log(
      `   ML-Only (${MLONLY_SYMBOL}):     ${mlStats.totalTrades} trades, WR ${mlStats.winRate.toFixed(0)}%, PnL $${mlStats.totalPnL.toFixed(2)}`,
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
