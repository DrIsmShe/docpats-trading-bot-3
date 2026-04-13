/**
 * PaperPositionStore — простое in-memory хранилище позиций для paper trading.
 *
 * В Phase 2 (когда подключим Mongo для трейдов) — заменим на MongoPositionStore.
 * В Phase 3 (когда подключим биржу) — добавим BinancePositionStore.
 *
 * Все эти варианты будут реализовывать одинаковый интерфейс,
 * чтобы PositionProvider мог работать с любым.
 */
export class PaperPositionStore {
  constructor() {
    this.positions = new Map(); // key: positionId, value: position
    this.nextId = 1;
  }

  /**
   * Открыть новую позицию.
   * Возвращает созданный объект позиции.
   */
  open({
    symbol,
    side, // "LONG" | "SHORT"
    entry,
    stopLoss,
    takeProfit,
    positionSize, // в базовом активе (BTC)
    notional, // в USDT
    margin, // в USDT
    leverage,
    strategyId,
    strategyName,
    confidence,
    reason,
  }) {
    const id = `paper_${this.nextId++}`;
    const position = {
      id,
      symbol,
      side,
      entry,
      stopLoss,
      takeProfit,
      positionSize,
      notional,
      margin,
      leverage,
      strategyId,
      strategyName,
      confidence,
      reason,
      status: "OPEN",
      openedAt: new Date().toISOString(),
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      pnl: null,
    };

    this.positions.set(id, position);
    return position;
  }

  /**
   * Получить все открытые позиции (опционально по символу).
   */
  getOpen(symbol = null) {
    const all = Array.from(this.positions.values()).filter(
      (p) => p.status === "OPEN",
    );
    if (symbol) return all.filter((p) => p.symbol === symbol);
    return all;
  }

  /**
   * Закрыть позицию.
   */
  close(id, { exitPrice, exitReason }) {
    const pos = this.positions.get(id);
    if (!pos) return null;
    if (pos.status !== "OPEN") return null;

    // PnL в USDT (без учёта комиссий — добавим в Phase 2)
    let pnl;
    if (pos.side === "LONG") {
      pnl = (exitPrice - pos.entry) * pos.positionSize;
    } else {
      pnl = (pos.entry - exitPrice) * pos.positionSize;
    }

    pos.status = "CLOSED";
    pos.closedAt = new Date().toISOString();
    pos.exitPrice = exitPrice;
    pos.exitReason = exitReason;
    pos.pnl = pnl;

    return pos;
  }

  /**
   * Все закрытые позиции — для статистики.
   */
  getClosed() {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "CLOSED",
    );
  }

  /**
   * Краткая статистика для логов.
   */
  getStats() {
    const closed = this.getClosed();
    const wins = closed.filter((p) => p.pnl > 0);
    const losses = closed.filter((p) => p.pnl <= 0);
    const totalPnL = closed.reduce((sum, p) => sum + p.pnl, 0);

    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      totalPnL,
      openPositions: this.getOpen().length,
    };
  }
}
