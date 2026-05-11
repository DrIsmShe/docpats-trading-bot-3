/**
 * btc-bot-v3 — Confluence Trading Bot (LIVE)
 *
 * ОДНА стратегия (Confluence) на НЕСКОЛЬКИХ символах одновременно.
 *
 * АРХИТЕКТУРА:
 *   server.js cycle:
 *     for each symbol in [BTC, ETH, AVAX, LINK]:
 *       1. cooldown check (per-symbol)
 *       2. open-position check (per-symbol)
 *       3. tradingEngine.run({ symbol })
 *            → ContextBuilder → ConfluenceStrategy → SignalAggregator
 *            → RiskManager (учитывает meta.fixedSize) → ExecutionService
 *
 * ПОЗИЦИИ:
 *   Один MongoPositionStore { strategyId: "confluence" } хранит все позиции
 *   по всем 4 символам. PositionMonitor мониторит этот store целиком.
 *
 * ML:
 *   Используется как size modifier (1.0x — 2.0x baseline) только для BTCUSDT.
 *   На остальных символах ML не вызывается, multiplier всегда 1.0.
 *
 * РЕЖИМЫ (через .env):
 *   TRADING_MODE=paper  → симуляция, позиции в памяти
 *   TRADING_MODE=live   → реальная торговля на Binance
 *
 * При старте в live режиме выполняется reconcileOnStartup — сверка БД↔биржа.
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
import { DerivativesProvider } from "./core/providers/derivativesProvider.js";

// Core
import { MarketLoader } from "./core/market/marketLoader.js";
import { MarketDataPoller } from "./core/market/marketDataPoller.js";
import { ContextBuilder } from "./core/context/ContextBuilder.js";
import { RiskManager } from "./core/risk/RiskManager.js";
import { ExecutionService } from "./core/execution/execution.service.js";
import { StrategyManager } from "./core/strategy/StrategyManager.js";
import { SignalAggregator } from "./core/signal/SignalAggregator.js";
import { TradingEngine } from "./core/engine/TradingEngine.js";
import { MongoPositionStore } from "./core/positions/MongoPositionStore.js";
import { PaperPositionStore } from "./core/positions/PaperPositionStore.js";
import { PositionMonitor } from "./core/positions/PositionMonitor.js";

// ML
import { MLClient } from "./core/ml/MLClient.js";

// Strategy
import { ConfluenceStrategy } from "./strategies/confluence/confluence.strategy.js";

// ── Configuration ──────────────────────────────────────────────────
const MODE = process.env.TRADING_MODE || "paper";
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || "60000");
const LEVERAGE = parseInt(process.env.LEVERAGE || "10");

// Multi-symbol: confluence работает на 4 символах одновременно
const SYMBOLS = (
  process.env.CONFLUENCE_SYMBOLS || "BTCUSDT,ETHUSDT,AVAXUSDT,LINKUSDT"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Cooldown per-symbol (минут после закрытия позиции на этом символе)
const COOLDOWN_AFTER_CLOSE_MS = parseInt(
  process.env.COOLDOWN_AFTER_CLOSE_MS || "900000", // 15 минут
);

// Daily loss limit (USDT)
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || "50");

// ML service
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:3001";

// ── Banner ─────────────────────────────────────────────────────────
console.log("═".repeat(70));
console.log("🚀 btc-bot-v3 — Confluence Strategy (Multi-Symbol)");
console.log("═".repeat(70));
console.log(`   Mode:            ${MODE.toUpperCase()}`);
console.log(`   Interval:        ${CYCLE_INTERVAL_MS / 1000}s`);
console.log(`   Leverage:        x${LEVERAGE}`);
console.log(`   Symbols:         [${SYMBOLS.join(", ")}]`);
console.log(`   ML URL:          ${ML_SERVICE_URL}`);
console.log(
  `   Cooldown:        ${COOLDOWN_AFTER_CLOSE_MS === 0 ? "disabled" : Math.round(COOLDOWN_AFTER_CLOSE_MS / 60000) + "min per-symbol"}`,
);
console.log(`   Daily loss:      $${DAILY_LOSS_LIMIT}`);
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

  // ── 4. Market Data Poller ───────────────────────────────────────
  let marketDataPoller = null;
  if (MODE === "live" || MODE === "testnet") {
    marketDataPoller = new MarketDataPoller({
      binanceClient,
      symbols: SYMBOLS,
      intervals: ["1h", "4h", "1d"],
    });
    console.log(`\n📥 MarketDataPoller: symbols=[${SYMBOLS.join(", ")}]`);
  }

  // ── 5. Providers ────────────────────────────────────────────────
  const candleProvider = new CandleProvider();
  const indicatorProvider = new IndicatorProvider();
  const regimeProvider = new RegimeProvider();
  const marketContextProvider = new MarketContextProvider({
    cacheTtlMs: 60_000,
  });
  const derivativesProvider = new DerivativesProvider({
    cacheTtlMs: 60_000,
  });

  const accountProvider =
    MODE === "live" || MODE === "testnet"
      ? new AccountProvider({ mode: "live", binanceClient, cacheTtlMs: 30_000 })
      : new AccountProvider({ mode: "mock", mockBalance: 144 });

  // ── 6. Position store (один на стратегию, фильтр по strategyId) ─
  const confluenceStore =
    MODE === "live" || MODE === "testnet"
      ? new MongoPositionStore({ strategyId: "confluence" })
      : new PaperPositionStore();

  // ── 7. Position provider ────────────────────────────────────────
  const positionProvider = new PositionProvider({
    mode: MODE === "paper" ? "paper" : "mongo",
    store: confluenceStore,
  });

  // ── 8. Execution service ────────────────────────────────────────
  const execution = new ExecutionService({
    mode: MODE,
    positionStore: confluenceStore,
    binanceClient,
  });

  // ── 9. Position Monitor (обобщённый под массив stores) ──────────
  const positionMonitor = new PositionMonitor({
    binanceClient,
    stores: [{ store: confluenceStore, name: "Confluence" }],
    pollIntervalMs: 5000,
  });

  // ── 10. Strategy ────────────────────────────────────────────────
  const confluenceStrategy = new ConfluenceStrategy({ mlClient });

  console.log(`\n📋 Registered strategy:`);
  console.log(
    `   ${confluenceStrategy.name} (${confluenceStrategy.id}) → [${SYMBOLS.join(", ")}]`,
  );

  // ── 11. Market Loader + Context Builder ─────────────────────────
  const marketLoader = new MarketLoader({
    candleProvider,
    indicatorProvider,
    accountProvider,
    positionProvider,
    regimeProvider,
    marketContextProvider,
    derivativesProvider,
  });

  // ContextBuilder.mlClient = null, потому что ML вызывается прямо
  // из ConfluenceStrategy (там сложнее логика согласия с Gate)
  const contextBuilder = new ContextBuilder({
    marketLoader,
    mlClient: null,
    strategies: [confluenceStrategy],
  });

  // ── 12. Strategy Manager + Aggregator + Risk + Engine ───────────
  const strategyManager = new StrategyManager({
    strategies: [confluenceStrategy],
  });

  const signalAggregator = new SignalAggregator({ minConfidence: 0.5 });

  const riskManager = new RiskManager({
    riskPerTrade: 0.01,
    minBalance: 10,
    maxPositionPctOfBalance: 5,
    minPositionUSDT: 5,
  });

  const tradingEngine = new TradingEngine({
    contextBuilder,
    strategyManager,
    signalAggregator,
    riskManager,
    executionService: execution,
    positionMonitor: null, // мониторинг отдельным фоновым процессом
  });

  // ── 13. Daily stats ─────────────────────────────────────────────
  const dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    pnL: 0,
  };

  const resetDailyStatsIfNewDay = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyStats.date) {
      console.log(`\n📅 New day: ${today}, resetting daily stats`);
      dailyStats.date = today;
      dailyStats.pnL = 0;
    }
  };

  const isStoppedByDailyLoss = () => dailyStats.pnL <= -DAILY_LOSS_LIMIT;

  // ── 14. Per-symbol cooldown check ───────────────────────────────
  async function isInCooldown(symbol) {
    if (COOLDOWN_AFTER_CLOSE_MS <= 0) return null;
    if (typeof confluenceStore.getLastClosedPositionBySymbol !== "function") {
      // Paper store не имеет этого метода — пропускаем cooldown
      return null;
    }
    const lastClosed =
      await confluenceStore.getLastClosedPositionBySymbol(symbol);
    if (!lastClosed?.closedAt) return null;

    const sinceCloseMs = Date.now() - new Date(lastClosed.closedAt).getTime();
    if (sinceCloseMs >= COOLDOWN_AFTER_CLOSE_MS) return null;

    const remainingSec = Math.ceil(
      (COOLDOWN_AFTER_CLOSE_MS - sinceCloseMs) / 1000,
    );
    const label =
      remainingSec >= 60
        ? `${Math.ceil(remainingSec / 60)}min`
        : `${remainingSec}s`;
    return `cooldown_${label}_after_${lastClosed.exitReason ?? "close"}`;
  }

  // ── 15. Main cycle ──────────────────────────────────────────────
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

      // 1. Подкачать свечи (для всех символов сразу)
      if (marketDataPoller) {
        await marketDataPoller.sync();
      }

      // 2. Daily loss check (global)
      if (isStoppedByDailyLoss()) {
        console.log(
          `⏹️  Daily loss limit hit ($${dailyStats.pnL.toFixed(2)} <= -$${DAILY_LOSS_LIMIT}), skip cycle`,
        );
        return;
      }

      // 3. Обработать каждый символ по очереди
      for (const symbol of SYMBOLS) {
        // 3a. Cooldown check (per-symbol)
        const cooldownReason = await isInCooldown(symbol);
        if (cooldownReason) {
          console.log(`\n⏸️  [${symbol}] skip: ${cooldownReason}`);
          continue;
        }

        // 3b. Open position check (per-symbol)
        const open =
          typeof confluenceStore.getOpenPositionBySymbol === "function"
            ? await confluenceStore.getOpenPositionBySymbol(symbol)
            : null;
        if (open) {
          console.log(
            `\n📌 [${symbol}] position already open (${open.side} @ ${open.entry}), skip`,
          );
          continue;
        }

        // 3c. Run trading engine
        console.log(`\n🔹 [${symbol}] running engine...`);
        const result = await tradingEngine.run({ symbol });
        console.log(
          `   → ${result.status}${result.reason ? ": " + result.reason : ""}`,
        );
      }

      // 4. Stats (общая + per-symbol breakdown)
      if (typeof confluenceStore.getStats === "function") {
        const stats = await confluenceStore.getStats();
        console.log(
          `\n📊 Total: ${stats.totalTrades} trades | WR ${stats.winRate.toFixed(0)}% | PF ${stats.profitFactor.toFixed(2)} | PnL $${stats.totalPnL.toFixed(2)} | Open: ${stats.openPositions}`,
        );
        console.log(`   Today PnL: $${dailyStats.pnL.toFixed(2)}`);

        if (typeof confluenceStore.getStatsBySymbol === "function") {
          const bySymbol = await confluenceStore.getStatsBySymbol();
          if (bySymbol.length > 0) {
            console.log(`   By symbol:`);
            for (const s of bySymbol) {
              const sign = s.totalPnL >= 0 ? "+" : "";
              console.log(
                `     ${s.symbol}: ${s.trades} trades | WR ${s.winRate.toFixed(0)}% | PF ${s.profitFactor.toFixed(2)} | PnL ${sign}$${s.totalPnL.toFixed(2)}`,
              );
            }
          }
        }
      }
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

  // ── 16. Startup reconcile ───────────────────────────────────────
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

  // ── 17. First cycle + start monitor + interval ──────────────────
  await runCycle();
  if (MODE === "live" || MODE === "testnet") {
    positionMonitor.start();
  }
  const interval = setInterval(runCycle, CYCLE_INTERVAL_MS);

  // ── 18. Graceful shutdown ───────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n\n🛑 ${signal} received, shutting down...`);
    clearInterval(interval);

    let waited = 0;
    while (isRunning && waited < 10000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }

    if (MODE === "live" || MODE === "testnet") {
      const open = await confluenceStore.getOpenPositions();
      if (open.length > 0) {
        console.log(`\n⚠️  Open positions remain on exchange:`);
        for (const p of open) {
          console.log(
            `   ${p.symbol} ${p.side} @ ${p.entry} (SL ${p.stopLoss}, TP ${p.takeProfit})`,
          );
        }
        console.log(`   They will continue to be monitored on next start.`);
      }
    }

    console.log("\n" + "═".repeat(70));
    console.log("FINAL STATS");
    console.log("═".repeat(70));

    if (typeof confluenceStore.getStats === "function") {
      const stats = await confluenceStore.getStats();
      console.log(`   Total cycles: ${cycleCount}`);
      console.log(
        `   Confluence: ${stats.totalTrades} trades, WR ${stats.winRate.toFixed(0)}%, PnL $${stats.totalPnL.toFixed(2)}`,
      );
    }
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
