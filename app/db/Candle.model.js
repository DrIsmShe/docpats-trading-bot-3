import mongoose from "mongoose";

/**
 * Модель свечи (OHLCV).
 *
 * Уникальный индекс по (symbol, interval, openTime) гарантирует
 * что одна и та же свеча не будет сохранена дважды.
 *
 * Используется через upsert в fetchCandles.
 */
const candleSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true },
    interval: { type: String, required: true, index: true },
    openTime: { type: Number, required: true },

    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, required: true },

    // На будущее — taker buy volume для impulse-фильтра
    buyVolume: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  },
);

candleSchema.index({ symbol: 1, interval: 1, openTime: 1 }, { unique: true });

export const Candle = mongoose.model("Candle", candleSchema);
