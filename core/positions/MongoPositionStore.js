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
 */
export class MongoPositionStore {
  constructor({ strategyId = null } = {}) {
    this.strategyId = strategyId;
  }

  async open(params) {
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

    const isLong = position.side === "BUY";
    const pnlPct = isLong
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;

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

  async getOpenPositions() {
    const filter = { status: "OPEN" };
    if (this.strategyId) filter.strategy = this.strategyId;

    const docs = await Position.find(filter).sort({ openedAt: -1 });
    return docs.map((d) => this._toDomain(d));
  }

  async getOpenPositionBySymbol(symbol) {
    const filter = { symbol, status: "OPEN" };
    if (this.strategyId) filter.strategy = this.strategyId;

    const doc = await Position.findOne(filter);
    return doc ? this._toDomain(doc) : null;
  }

  async getOpenPositionByClientOrderId(clientOrderId) {
    const doc = await Position.findOne({ clientOrderId, status: "OPEN" });
    return doc ? this._toDomain(doc) : null;
  }

  async getById(positionId) {
    const doc = await Position.findById(positionId);
    return doc ? this._toDomain(doc) : null;
  }

  /**
   * [FIX #2] Последняя ЗАКРЫТАЯ позиция этой стратегии (по всем символам).
   * Используется для global cooldown (если применимо).
   */
  async getLastClosedPosition() {
    const filter = { status: "CLOSED" };
    if (this.strategyId) filter.strategy = this.strategyId;
    const doc = await Position.findOne(filter).sort({ closedAt: -1 });
    return doc ? this._toDomain(doc) : null;
  }

  /**
   * [NEW] Последняя ЗАКРЫТАЯ позиция по конкретному символу.
   * Используется для per-symbol cooldown в multi-symbol стратегиях
   * (Confluence): когда BTC закрылся — пауза на BTC, но ETH можно
   * торговать сразу.
   */
  async getLastClosedPositionBySymbol(symbol) {
    const filter = { symbol, status: "CLOSED" };
    if (this.strategyId) filter.strategy = this.strategyId;
    const doc = await Position.findOne(filter).sort({ closedAt: -1 });
    return doc ? this._toDomain(doc) : null;
  }

  async updateExchangeIds(positionId, { orderId, slOrderId, tpOrderId }) {
    const update = {};
    if (orderId !== undefined) update.orderId = orderId;
    if (slOrderId !== undefined) update.slOrderId = slOrderId;
    if (tpOrderId !== undefined) update.tpOrderId = tpOrderId;

    await Position.updateOne({ _id: positionId }, { $set: update });
  }

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

  async getStats() {
    const filter = { status: "CLOSED" };
    if (this.strategyId) filter.strategy = this.strategyId;

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

    const openFilter = { status: "OPEN" };
    if (this.strategyId) openFilter.strategy = this.strategyId;
    const openPositions = await Position.countDocuments(openFilter);

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
   * [NEW] Per-symbol breakdown статистики.
   * Полезно для confluence: видеть какой символ работает лучше.
   */
  async getStatsBySymbol() {
    const filter = { status: "CLOSED" };
    if (this.strategyId) filter.strategy = this.strategyId;

    const closed = await Position.find(filter);
    const bySymbol = new Map();

    for (const p of closed) {
      const sym = p.symbol;
      if (!bySymbol.has(sym)) {
        bySymbol.set(sym, {
          symbol: sym,
          trades: 0,
          wins: 0,
          losses: 0,
          totalPnL: 0,
          totalProfit: 0,
          totalLoss: 0,
        });
      }
      const s = bySymbol.get(sym);
      s.trades++;
      const pnl = p.pnlUSDT ?? 0;
      s.totalPnL += pnl;
      if (pnl > 0) {
        s.wins++;
        s.totalProfit += pnl;
      } else {
        s.losses++;
        s.totalLoss += Math.abs(pnl);
      }
    }

    return Array.from(bySymbol.values()).map((s) => ({
      ...s,
      winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
      profitFactor:
        s.totalLoss > 0
          ? s.totalProfit / s.totalLoss
          : s.totalProfit > 0
            ? 99
            : 0,
    }));
  }

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
