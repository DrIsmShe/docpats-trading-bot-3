/**
 * Backfill candles — однократный скрипт для догрузки исторических свечей.
 *
 * Используется когда символ только что добавлен и в БД мало свечей.
 * MarketDataPoller сам подтягивает только обновления, исторические данные
 * приходится догонять отдельным проходом.
 *
 * USAGE:
 *   node backfill_candles.js                                       # default 1500 свечей
 *   node backfill_candles.js AVAXUSDT,LINKUSDT                     # символы из аргумента
 *   node backfill_candles.js AVAXUSDT,LINKUSDT 1500                # символы и количество
 *
 * Загружает 1h/4h/1d с глубиной по умолчанию 1500 свечей.
 * Binance API limit = 1500 свечей за один запрос, поэтому делаем
 * пагинацию через endTime если нужно больше.
 */

import "dotenv/config";
import { connectMongo, disconnectMongo } from "./app/db/mongo.js";
import { BinanceFuturesClient } from "./core/providers/binanceFuturesClient.js";
import { Candle } from "./app/db/Candle.model.js";

const DEFAULT_SYMBOLS = ["AVAXUSDT", "LINKUSDT"];
const DEFAULT_DEPTH = 1500;
const INTERVALS = ["1h", "4h", "1d"];

// CLI args
const argSymbols = process.argv[2];
const argDepth = process.argv[3];

const SYMBOLS = argSymbols
  ? argSymbols.split(",").map((s) => s.trim())
  : DEFAULT_SYMBOLS;
const DEPTH = argDepth ? parseInt(argDepth) : DEFAULT_DEPTH;

console.log("═".repeat(60));
console.log("📥 Candle Backfill");
console.log("═".repeat(60));
console.log(`   Symbols:  [${SYMBOLS.join(", ")}]`);
console.log(`   Depth:    ${DEPTH} candles per interval`);
console.log(`   Intervals: [${INTERVALS.join(", ")}]`);
console.log("═".repeat(60));

async function backfillOne(client, symbol, interval, depth) {
  // Binance возвращает максимум 1500 свечей за один запрос.
  // Если depth больше — делаем несколько запросов с пагинацией через endTime.
  let allCandles = [];
  let endTime = null;
  let remaining = depth;

  while (remaining > 0) {
    const limit = Math.min(remaining, 1500);
    const batch = await client.getCandles(symbol, interval, limit, endTime);

    if (!batch || batch.length === 0) break;

    allCandles = [...batch, ...allCandles];

    if (batch.length < limit) break; // больше нет данных

    // Следующая итерация — берём свечи раньше первой текущей
    endTime = batch[0].openTime - 1;
    remaining -= batch.length;
  }

  if (allCandles.length === 0) {
    console.log(`   ⚠️  ${symbol} ${interval}: no data returned`);
    return 0;
  }

  // Дедуп по openTime
  const seen = new Set();
  const unique = allCandles.filter((c) => {
    if (seen.has(c.openTime)) return false;
    seen.add(c.openTime);
    return true;
  });

  // Bulk upsert в Mongo
  const ops = unique.map((c) => ({
    updateOne: {
      filter: { symbol, interval, openTime: c.openTime },
      update: {
        $set: {
          symbol,
          interval,
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          closeTime: c.closeTime,
          buyVolume: c.buyVolume,
        },
      },
      upsert: true,
    },
  }));

  const result = await Candle.bulkWrite(ops, { ordered: false });
  const upserted = result.upsertedCount ?? 0;
  const modified = result.modifiedCount ?? 0;

  return upserted + modified;
}

async function main() {
  await connectMongo(process.env.MONGO_URI);

  const client = new BinanceFuturesClient({
    apiKey: process.env.BINANCE_FUTURES_API_KEY,
    apiSecret: process.env.BINANCE_FUTURES_SECRET_KEY,
  });

  for (const symbol of SYMBOLS) {
    console.log(`\n📊 ${symbol}`);
    for (const interval of INTERVALS) {
      const before = await Candle.countDocuments({ symbol, interval });
      try {
        const count = await backfillOne(client, symbol, interval, DEPTH);
        const after = await Candle.countDocuments({ symbol, interval });
        console.log(
          `   ${interval}: ${count} processed | DB: ${before} → ${after}`,
        );
      } catch (err) {
        console.error(`   ❌ ${interval}: ${err.message}`);
      }
    }
  }

  await disconnectMongo();
  console.log("\n✅ Backfill complete\n");
}

main().catch(async (err) => {
  console.error("\n❌ Backfill failed:", err);
  await disconnectMongo();
  process.exit(1);
});
