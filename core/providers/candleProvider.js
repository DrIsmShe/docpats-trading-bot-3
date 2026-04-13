import { Candle } from "../../app/db/Candle.model.js";

/**
 * CandleProvider — единая точка доступа к свечам.
 *
 * Стратегии и MarketLoader не лезут в Mongo напрямую.
 * Они зовут этот провайдер.
 *
 * Преимущества:
 *   - Если завтра мы поменяем Mongo на Postgres / Redis cache /
 *     внешний market-data сервис — меняем только этот файл.
 *   - Стратегии остаются как есть.
 */
export class CandleProvider {
  /**
   * Получить N последних свечей для символа и таймфрейма.
   *
   * @param {string} symbol     - например "BTCUSDT"
   * @param {string} interval   - "15m" | "1h" | "4h" | "1d"
   * @param {number} limit      - сколько последних свечей вернуть
   * @returns {Promise<Array>}  - массив свечей в порядке от старых к новым
   */
  async getCandles(symbol, interval, limit = 100) {
    if (!symbol || !interval) {
      throw new Error(
        "CandleProvider.getCandles: symbol и interval обязательны",
      );
    }

    // Берём limit последних свечей (в порядке от новых к старым)
    // и потом разворачиваем чтобы получить хронологический порядок
    const docs = await Candle.find({ symbol, interval })
      .sort({ openTime: -1 })
      .limit(limit)
      .lean();

    return docs.reverse().map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      buyVolume: c.buyVolume ?? 0,
    }));
  }

  /**
   * Последняя свеча — для быстрого получения текущей цены.
   */
  async getLastCandle(symbol, interval) {
    if (!symbol || !interval) {
      throw new Error(
        "CandleProvider.getLastCandle: symbol и interval обязательны",
      );
    }

    const doc = await Candle.findOne({ symbol, interval })
      .sort({ openTime: -1 })
      .lean();

    if (!doc) return null;

    return {
      openTime: doc.openTime,
      open: doc.open,
      high: doc.high,
      low: doc.low,
      close: doc.close,
      volume: doc.volume,
      buyVolume: doc.buyVolume ?? 0,
    };
  }

  /**
   * Сколько свечей в базе для данного символа и таймфрейма.
   * Полезно для health check и отладки.
   */
  async count(symbol, interval) {
    return await Candle.countDocuments({ symbol, interval });
  }
}
