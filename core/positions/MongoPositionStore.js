import { Position } from "../../app/db/Position.model.js";

/**
 * MongoPositionStore — хранилище позиций в MongoDB.
 *
 * Заменяет PaperPositionStore для production режима.
 * Отличия от PaperPositionStore:
 *   - Позиции сохраняются в Mongo (выживают рестарт бота)
 *   - Поддерживает фильтрацию по strategy (для двух ботов в одной БД)
 *   - Содержит поля для Binance integration (orderId, slOrderId, tpOrderId)
 *   - Совместим с одновременной работой нескольких стратегий
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   const store = new MongoPositionStore({ strategyId: "breakout" });
 *
 *   // При открытии:
 *   const position = await store.open({
 *     symbol: "BTCUSDT",
 *     side: "LONG",
 *     entry: 73000,
 *     ...
 *   });
 *
 *   // Найти открытые позиции этой стратегии:
 *   const openPositions = await store.getOpenPositions();
 *
 *   // Закрыть позицию:
 *   await store.close(positionId, { exitPrice: 73500, exitReason: "TP" });
 */
export class MongoPositionStore {
  /**
   * @param {object} options
   * @param {string} [options.strategyId] - если задан, store работает ТОЛЬКО с позициями этой стратегии
   */
  constructor({ strategyId = null } = {}) {
    this.strategyId = strategyId;
  }

  /**
   * Создать новую позицию в БД.
   *
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.side - "LONG" | "SHORT"
   * @param {number} params.entry - цена входа
   * @param {number} params.stopLoss
   * @param {number} params.takeProfit
   * @param {number} params.positionSize - количество BTC (например 0.002)
   * @param {number} params.notional - в USDT (positionSize * entry)
   * @param {number} params.leverage
   * @param {string} params.strategyId - id стратегии (breakout / mlOnly)
   * @param {string} params.strategyName
   * @param {number} [params.confidence]
   * @param {string} [params.reason]
   * @param {string} [params.clientOrderId] - наш ID для отслеживания на бирже
   * @param {string} [params.orderId] - Binance orderId главного ордера
   * @param {string} [params.slOrderId] - Binance orderId STOP_MARKET
   * @param {string} [params.tpOrderId] - Binance orderId TAKE_PROFIT_MARKET
   * @param {string} [params.mlSignal]
   * @param {number} [params.mlConfidence]
   */
  async open(params) {
    // side: LONG → BUY, SHORT → SELL (для совместимости с серверным ботом)
    const positionSide = params.side === "LONG" ? "BUY" : "SELL";

    const doc = await Position.create({
      symbol: params.symbol,
      side: positionSide,
      strategy: params.strategyId ?? this.strategyId ?? "Unknown",
      entryPrice: params.entry,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      quantity: params.positionSize,
      usdtAmount: params.notional,
      leverage: params.leverage ?? 10,
      orderId: params.orderId ?? null,
      clientOrderId: params.clientOrderId ?? null,
      slOrderId: params.slOrderId ?? null,
      tpOrderId: params.tpOrderId ?? null,
      status: "OPEN",
      mlSignal: params.mlSignal ?? "HOLD",
      mlConfidence: params.mlConfidence ?? 0,
      reason: params.reason ?? null,
      openedAt: new Date(),
    });

    return this._toDomain(doc);
  }

  /**
   * Закрыть позицию.
   *
   * @param {string} positionId - _id из Mongo (или clientOrderId)
   * @param {object} params
   * @param {number} params.exitPrice
   * @param {string} params.exitReason - "TP" | "SL" | "TIME" | "MANUAL" | "ERROR"
   */
  async close(positionId, { exitPrice, exitReason }) {
    const position = await Position.findById(positionId);
    if (!position) {
      console.warn(
        `⚠️  MongoPositionStore.close: position ${positionId} not found`,
      );
      return null;
    }

    if (position.status !== "OPEN") {
      console.warn(
        `⚠️  MongoPositionStore.close: position ${positionId} already closed (status: ${position.status})`,
      );
      return null;
    }

    // Вычисляем PnL
    const isLong = position.side === "BUY";
    const pnlPct = isLong
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;

    // PnL в USDT = pnlPct × notional
    const pnlUSDT = pnlPct * position.usdtAmount;

    position.exitPrice = exitPrice;
    position.pnlPercent = pnlPct * 100;
    position.pnlUSDT = pnlUSDT;
    position.closeReason = exitReason;
    position.closedAt = new Date();
    position.status = "CLOSED";

    await position.save();

    return this._toDomain(position);
  }

  /**
   * Получить ВСЕ открытые позиции (с фильтром по strategyId если задан).
   */
  async getOpenPositions() {
    const filter = { status: "OPEN" };
    if (this.strategyId) {
      filter.strategy = this.strategyId;
    }

    const docs = await Position.find(filter).sort({ openedAt: -1 });
    return docs.map((d) => this._toDomain(d));
  }

  /**
   * Получить открытую позицию по символу (если есть).
   */
  async getOpenPositionBySymbol(symbol) {
    const filter = { symbol, status: "OPEN" };
    if (this.strategyId) {
      filter.strategy = this.strategyId;
    }

    const doc = await Position.findOne(filter);
    return doc ? this._toDomain(doc) : null;
  }

  /**
   * Получить открытую позицию по clientOrderId.
   */
  async getOpenPositionByClientOrderId(clientOrderId) {
    const doc = await Position.findOne({ clientOrderId, status: "OPEN" });
    return doc ? this._toDomain(doc) : null;
  }

  /**
   * Найти позицию по _id (вернёт независимо от статуса).
   */
  async getById(positionId) {
    const doc = await Position.findById(positionId);
    return doc ? this._toDomain(doc) : null;
  }

  /**
   * Обновить связь с биржей (orderId, slOrderId, tpOrderId).
   * Используется когда сначала создали запись в Mongo, потом получили ответ от Binance.
   */
  async updateExchangeIds(positionId, { orderId, slOrderId, tpOrderId }) {
    const update = {};
    if (orderId !== undefined) update.orderId = orderId;
    if (slOrderId !== undefined) update.slOrderId = slOrderId;
    if (tpOrderId !== undefined) update.tpOrderId = tpOrderId;

    await Position.updateOne({ _id: positionId }, { $set: update });
  }

  /**
   * Пометить позицию как ERROR (что-то пошло не так при открытии).
   */
  async markError(positionId, errorMessage) {
    await Position.updateOne(
      { _id: positionId },
      {
        $set: {
          status: "ERROR",
          closeReason: `ERROR: ${errorMessage}`,
          closedAt: new Date(),
        },
      },
    );
  }

  /**
   * Получить статистику по закрытым позициям этой стратегии.
   */
  async getStats() {
    const filter = { status: "CLOSED" };
    if (this.strategyId) {
      filter.strategy = this.strategyId;
    }

    const closed = await Position.find(filter);

    const totalTrades = closed.length;
    const wins = closed.filter((p) => p.pnlUSDT > 0);
    const losses = closed.filter((p) => p.pnlUSDT <= 0);

    const totalPnL = closed.reduce((sum, p) => sum + (p.pnlUSDT ?? 0), 0);
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

    const totalProfit = wins.reduce((sum, p) => sum + p.pnlUSDT, 0);
    const totalLoss = Math.abs(losses.reduce((sum, p) => sum + p.pnlUSDT, 0));
    const profitFactor =
      totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 99 : 0;

    const openPositions = await Position.countDocuments({
      ...filter,
      status: "OPEN",
    });

    return {
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnL,
      profitFactor,
      openPositions,
    };
  }

  /**
   * Преобразовать Mongo document в domain объект.
   * Domain объект — это тот формат который ожидает остальной код (ExecutionService, PositionMonitor).
   */
  _toDomain(doc) {
    return {
      id: doc._id.toString(),
      symbol: doc.symbol,
      side: doc.side === "BUY" ? "LONG" : "SHORT",
      entry: doc.entryPrice,
      stopLoss: doc.stopLoss,
      takeProfit: doc.takeProfit,
      positionSize: doc.quantity,
      notional: doc.usdtAmount,
      leverage: doc.leverage,
      orderId: doc.orderId,
      clientOrderId: doc.clientOrderId,
      slOrderId: doc.slOrderId,
      tpOrderId: doc.tpOrderId,
      status: doc.status,
      strategyId: doc.strategy,
      strategyName: doc.strategy,
      confidence: doc.mlConfidence,
      mlSignal: doc.mlSignal,
      mlConfidence: doc.mlConfidence,
      reason: doc.reason,
      openedAt: doc.openedAt,
      closedAt: doc.closedAt,
      exitPrice: doc.exitPrice,
      exitReason: doc.closeReason,
      pnl: doc.pnlUSDT,
      pnlPct: doc.pnlPercent,
    };
  }
}
