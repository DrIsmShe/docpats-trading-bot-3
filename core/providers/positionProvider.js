/**
 * PositionProvider — даёт информацию об открытых позициях.
 *
 * РЕЖИМЫ:
 *   - paper: читает из PaperPositionStore (in-memory)
 *   - mongo: читает из MongoPositionStore (MongoDB)
 *
 * Интерфейс одинаковый для обоих режимов.
 * Стратегии/MarketLoader не знают какой режим используется.
 */
export class PositionProvider {
  constructor({ mode = "paper", store = null } = {}) {
    this.mode = mode;
    this.store = store;

    if (!store) {
      throw new Error("PositionProvider requires store");
    }
  }

  /**
   * Получить все открытые позиции.
   * @returns {Promise<Array>}
   */
  async getOpenPositions() {
    if (this.mode === "paper") {
      // PaperPositionStore.getOpenPositions() — sync, возвращает массив
      const result = this.store.getOpenPositions();
      return Array.isArray(result) ? result : [];
    }

    if (this.mode === "mongo") {
      // MongoPositionStore.getOpenPositions() — async, возвращает Promise<Array>
      const result = await this.store.getOpenPositions();
      return Array.isArray(result) ? result : [];
    }

    throw new Error(`PositionProvider mode "${this.mode}" not supported`);
  }

  /**
   * Получить открытую позицию по символу (если есть).
   */
  async getOpenPositionBySymbol(symbol) {
    const positions = await this.getOpenPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }
}
