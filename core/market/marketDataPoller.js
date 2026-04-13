import { Candle } from "../../app/db/Candle.model.js";

/**
 * MarketDataPoller — подкачивает свежие свечи с Binance в Mongo.
 *
 * ПРОБЛЕМА:
 *   CandleProvider читает свечи из Mongo. Если их никто не обновляет,
 *   бот будет торговать на устаревших данных.
 *
 * РЕШЕНИЕ:
 *   Перед каждым торговым циклом этот поллер:
 *   1. Проверяет последнюю свечу в Mongo для каждого таймфрейма
 *   2. Запрашивает у Binance свечи начиная с этого момента
 *   3. Upsert новых свечей в Mongo
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   const poller = new MarketDataPoller({
 *     binanceClient,
 *     symbols: ["BTCUSDT"],
 *     intervals: ["1h", "4h", "1d"],
 *   });
 *
 *   // Вызывается в начале каждого цикла ДО получения контекста
 *   await poller.sync();
 */
export class MarketDataPoller {
  constructor({
    binanceClient,
    symbols = ["BTCUSDT"],
    intervals = ["1h", "4h", "1d"],
    fetchLimit = 100,
  } = {}) {
    if (!binanceClient) {
      throw new Error("MarketDataPoller requires binanceClient");
    }
    this.binanceClient = binanceClient;
    this.symbols = symbols;
    this.intervals = intervals;
    this.fetchLimit = fetchLimit;
  }

  /**
   * Синхронизировать все пары symbol/interval.
   * Возвращает статистику сколько свечей подкачалось.
   */
  async sync() {
    const stats = {};

    for (const symbol of this.symbols) {
      stats[symbol] = {};
      for (const interval of this.intervals) {
        try {
          const count = await this._syncOne(symbol, interval);
          stats[symbol][interval] = count;
        } catch (err) {
          console.error(
            `❌ MarketDataPoller ${symbol} ${interval}: ${err.message}`,
          );
          stats[symbol][interval] = -1;
        }
      }
    }

    return stats;
  }

  /**
   * Синхронизировать одну пару symbol/interval.
   * Возвращает количество добавленных/обновлённых свечей.
   */
  async _syncOne(symbol, interval) {
    // 1. Найти последнюю свечу в Mongo
    const lastInDb = await Candle.findOne({ symbol, interval })
      .sort({ openTime: -1 })
      .lean();

    // 2. Запросить у Binance последние N свечей
    //    Важно: Binance возвращает и закрытые, и текущую незакрытую свечу
    const fresh = await this.binanceClient.getCandles(
      symbol,
      interval,
      this.fetchLimit,
    );

    if (!fresh || fresh.length === 0) {
      return 0;
    }

    // 3. Фильтруем только закрытые свечи
    //    Последняя свеча в ответе Binance — это текущая (ещё не закрытая)
    //    Её брать нельзя — её значения ещё изменятся
    const intervalMs = this._intervalToMs(interval);
    const now = Date.now();
    const closedCandles = fresh.filter((c) => {
      const candleCloseTime = c.openTime + intervalMs;
      return candleCloseTime <= now;
    });

    if (closedCandles.length === 0) {
      return 0;
    }

    // 4. Фильтруем только новые (которых ещё нет в Mongo) или изменившиеся
    const lastDbTime = lastInDb?.openTime ?? 0;
    const newCandles = closedCandles.filter((c) => c.openTime >= lastDbTime);

    if (newCandles.length === 0) {
      return 0;
    }

    // 5. Bulk upsert
    const ops = newCandles.map((c) => ({
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

    if (upserted > 0 || modified > 0) {
      const lastTime = newCandles.at(-1).openTime;
      console.log(
        `📥 [${symbol} ${interval}] +${upserted} new, ${modified} updated | last: ${new Date(lastTime).toISOString().slice(0, 16)}`,
      );
    }

    return upserted + modified;
  }

  /**
   * Преобразовать интервал Binance в миллисекунды.
   */
  _intervalToMs(interval) {
    const unit = interval.slice(-1);
    const num = parseInt(interval.slice(0, -1));

    switch (unit) {
      case "m":
        return num * 60 * 1000;
      case "h":
        return num * 60 * 60 * 1000;
      case "d":
        return num * 24 * 60 * 60 * 1000;
      case "w":
        return num * 7 * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unknown interval: ${interval}`);
    }
  }
}
