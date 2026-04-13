import mongoose from "mongoose";

/**
 * Position — модель Mongo для хранения торговых позиций.
 *
 * Одна запись = вся жизнь позиции (от открытия до закрытия).
 * При открытии: status="OPEN", exitPrice=null, pnlUSDT=null.
 * При закрытии: status="CLOSED", exitPrice/pnlUSDT/closedAt/closeReason заполнены.
 *
 * Используется обоими стратегиями (Breakout и ML-Only).
 * Различаются по полю `strategy` (ID стратегии).
 *
 * Поля mlSignal/mlConfidence заполняются в момент открытия для последующего анализа.
 */
const PositionSchema = new mongoose.Schema({
  // Идентификация
  symbol: { type: String, required: true },
  side: { type: String, enum: ["BUY", "SELL"], required: true },
  strategy: { type: String, required: true, default: "Unknown" },

  // Цены и количество
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  quantity: { type: Number, required: true },
  usdtAmount: { type: Number, required: true },

  // Управление риском
  stopLoss: { type: Number },
  takeProfit: { type: Number },

  // Связь с биржей
  orderId: { type: String }, // Binance orderId главного ордера
  clientOrderId: { type: String }, // Наш ID с префиксом BRK_xxx или ML_xxx
  slOrderId: { type: String }, // Binance orderId для STOP_MARKET
  tpOrderId: { type: String }, // Binance orderId для TAKE_PROFIT_MARKET

  // Статус
  status: {
    type: String,
    enum: ["OPEN", "CLOSED", "ERROR"],
    default: "OPEN",
  },

  // Результат (заполняется при закрытии)
  pnlPercent: { type: Number },
  pnlUSDT: { type: Number },
  closeReason: { type: String }, // "TP" | "SL" | "TIME" | "MANUAL" | "ERROR"

  // Время
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },

  // ML контекст (заполняется при открытии для анализа)
  mlSignal: { type: String, default: "HOLD" },
  mlConfidence: { type: Number, default: 0 },

  // Дополнительный контекст
  reason: { type: String }, // строка причины открытия (от стратегии)
  leverage: { type: Number, default: 10 },
});

// Индексы для быстрого поиска
PositionSchema.index({ symbol: 1, status: 1 });
PositionSchema.index({ strategy: 1, status: 1 });
PositionSchema.index({ clientOrderId: 1 });
PositionSchema.index({ openedAt: -1 });

// Мы экспортируем как named export чтобы было единообразно с Candle.model.js
export const Position =
  mongoose.models.Position || mongoose.model("Position", PositionSchema);

export default Position;
