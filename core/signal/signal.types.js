/**
 * Единый формат сигналов для всей системы.
 *
 * Все стратегии возвращают объект этой формы.
 * Это позволяет StrategyManager и SignalAggregator работать
 * с любой стратегией одинаково.
 */

export const SIGNAL_TYPES = {
  BUY: "BUY",
  SELL: "SELL",
  HOLD: "HOLD",
};

/**
 * Хелпер для создания HOLD-сигнала.
 * Используется когда стратегия не нашла сетапа,
 * чтобы не дублировать boilerplate в каждой стратегии.
 */
export const createHoldSignal = ({
  strategyId,
  strategyName,
  symbol,
  reason = "No signal",
  meta = {},
}) => {
  return {
    strategyId,
    strategyName,
    symbol,
    type: SIGNAL_TYPES.HOLD,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    confidence: 0,
    reason,
    meta,
  };
};

/**
 * Хелпер для создания торгового сигнала (BUY/SELL).
 * Стандартизирует формат и валидирует обязательные поля.
 */
export const createTradeSignal = ({
  strategyId,
  strategyName,
  symbol,
  type,
  entry,
  stopLoss,
  takeProfit,
  confidence,
  reason,
  meta = {},
}) => {
  if (type !== SIGNAL_TYPES.BUY && type !== SIGNAL_TYPES.SELL) {
    throw new Error(`createTradeSignal: type must be BUY or SELL, got ${type}`);
  }
  if (!entry || !stopLoss || !takeProfit) {
    throw new Error(
      `createTradeSignal: entry, stopLoss and takeProfit are required`,
    );
  }
  return {
    strategyId,
    strategyName,
    symbol,
    type,
    entry,
    stopLoss,
    takeProfit,
    confidence: confidence ?? 0.5,
    reason: reason ?? "",
    meta,
  };
};
