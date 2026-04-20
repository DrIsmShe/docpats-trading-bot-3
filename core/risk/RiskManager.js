/**
 * RiskManager — единственное место в системе, где принимается решение
 * "торговать или нет" и "сколько именно".
 *
 * ВАЖНО: правильно учитывает ПЛЕЧО. Это та самая ошибка которая убила
 * серверный бот: расчёт без leverage давал размер позиции в 10 раз больше
 * планового риска при использовании x10 фьючерсов.
 *
 * ФОРМУЛА правильного расчёта позиции:
 *
 *   1. riskAmount = balance * riskPerTrade
 *      Сколько USDT мы готовы потерять при срабатывании SL.
 *
 *   2. stopDistancePct = |entry - stopLoss| / entry
 *      Расстояние до SL в долях от цены входа.
 *
 *   3. positionNotional = riskAmount / stopDistancePct
 *      Полный размер позиции (в USDT) при котором при срабатывании
 *      SL мы потеряем ровно riskAmount.
 *
 *   4. positionSize = positionNotional / entry
 *      Размер позиции в базовом активе (BTC).
 *
 *   5. requiredMargin = positionNotional / leverage
 *      Маржа которую заблокирует биржа.
 *
 * ПОЧЕМУ ПЛЕЧО НЕ ВХОДИТ В ФОРМУЛУ РАЗМЕРА ПОЗИЦИИ:
 * Плечо влияет только на ТРЕБУЕМУЮ МАРЖУ, но не на размер позиции
 * и не на убыток при SL. С плечом x10 ты блокируешь $14 маржи и можешь
 * открыть позицию $140; при срабатывании SL на 1% потеряешь $1.4 (риск).
 * Без плеча ты блокируешь $140 маржи и при том же SL теряешь те же $1.4.
 *
 * Плечо позволяет экономить капитал, не увеличивая риск на сделку.
 *
 * ─────────────────────────────────────────────────────────────────────
 * API:
 *   - apply(signal, context)              — высокоуровневый интерфейс
 *                                            для TradingEngine, требует
 *                                            полный context
 *   - buildPlan({ signal, balance, leverage }) — низкоуровневый
 *                                            интерфейс для server.js
 *                                            runStrategy, context не нужен
 * ─────────────────────────────────────────────────────────────────────
 */
export class RiskManager {
  constructor({
    riskPerTrade = 0.01, // 1% от баланса на сделку
    minBalance = 10, // не торговать ниже этого баланса
    maxPositionPctOfBalance = 5, // максимум 5x от баланса (страховка от багов)
    minPositionUSDT = 5, // меньше этого биржа отвергнет ордер
  } = {}) {
    this.riskPerTrade = riskPerTrade;
    this.minBalance = minBalance;
    this.maxPositionPctOfBalance = maxPositionPctOfBalance;
    this.minPositionUSDT = minPositionUSDT;
  }

  /**
   * Применить риск-менеджмент к торговому сигналу (high-level, для TradingEngine).
   *
   * @param {Object} signal  - сигнал от стратегии
   * @param {Object} context - полный контекст рынка (нужен для balance, positions, riskProfile)
   * @returns {Object}       - { allowed: bool, reason, ...signal, positionSize, requiredMargin, ... }
   */
  apply(signal, context) {
    // ── 1. Базовая валидация сигнала ────────────────────────────
    if (!signal) {
      return { allowed: false, reason: "No signal" };
    }
    if (!signal.entry || !signal.stopLoss || !signal.takeProfit) {
      return {
        allowed: false,
        reason: "Signal missing entry/SL/TP",
      };
    }

    // ── 2. Проверка открытых позиций ────────────────────────────
    if (context.positions?.hasOpenPosition) {
      return {
        allowed: false,
        reason: "Position already open for this symbol",
      };
    }

    // ── 3. Проверка баланса ─────────────────────────────────────
    const balance = context.balances?.futures ?? 0;
    if (balance < this.minBalance) {
      return {
        allowed: false,
        reason: `Balance too low: $${balance.toFixed(2)} < $${this.minBalance}`,
      };
    }

    // ── 4. Получить риск-профиль стратегии ──────────────────────
    const strategy = context.strategies?.find(
      (s) => s.id === signal.strategyId,
    );
    const riskProfile = strategy?.getRiskProfile?.() ?? {
      leverage: 1,
      slMultiplier: 1.5,
      tpMultiplier: 3.0,
    };
    const leverage = riskProfile.leverage ?? 1;

    return this._compute({ signal, balance, leverage });
  }

  /**
   * [FIX #5] Построить plan для сигнала без полного context.
   *
   * Используется в server.js runStrategy — там context ещё не строится
   * для Breakout (RiskManager вызывается по упрощённому пути), поэтому
   * apply() не подходит. Этот метод берёт balance и leverage напрямую
   * из параметров.
   *
   * До этого фикса server.js вызывал несуществующий метод buildPlan,
   * что порождало TypeError в каждом цикле, где Breakout давал сигнал.
   *
   * @param {Object} params
   * @param {Object} params.signal   - сигнал стратегии с entry/stopLoss/takeProfit
   * @param {number} params.balance  - баланс в USDT
   * @param {number} params.leverage - плечо (по умолчанию 1)
   * @returns {Object} plan - { allowed, reason, positionSize, positionNotional, requiredMargin, leverage, riskAmount }
   */
  buildPlan({ signal, balance, leverage = 1 }) {
    if (!signal) {
      return { allowed: false, reason: "No signal" };
    }
    if (!signal.entry || !signal.stopLoss) {
      return {
        allowed: false,
        reason: "Signal missing entry/stopLoss",
      };
    }
    if (balance == null || balance < this.minBalance) {
      return {
        allowed: false,
        reason: `Balance too low: $${(balance ?? 0).toFixed(2)} < $${this.minBalance}`,
      };
    }
    return this._compute({ signal, balance, leverage });
  }

  /**
   * Внутренний расчёт размера позиции.
   * Используется и apply(), и buildPlan() — единая формула.
   */
  _compute({ signal, balance, leverage }) {
    const entry = signal.entry;
    const stopLoss = signal.stopLoss;
    const stopDistance = Math.abs(entry - stopLoss);

    if (stopDistance <= 0) {
      return {
        allowed: false,
        reason: "Invalid stop distance (zero or negative)",
      };
    }

    const stopDistancePct = stopDistance / entry;

    // КЛЮЧЕВАЯ ФОРМУЛА: размер позиции рассчитывается так,
    // чтобы при срабатывании SL потерять ровно riskAmount
    const riskAmount = balance * this.riskPerTrade;
    const positionNotional = riskAmount / stopDistancePct;
    const positionSize = positionNotional / entry;
    const requiredMargin = positionNotional / leverage;

    // ── Защитные проверки ───────────────────────────────────────
    if (positionNotional < this.minPositionUSDT) {
      return {
        allowed: false,
        reason: `Position too small: $${positionNotional.toFixed(2)} < $${this.minPositionUSDT}`,
        debug: { riskAmount, stopDistancePct, positionNotional },
      };
    }

    const maxAllowedNotional = balance * this.maxPositionPctOfBalance;
    if (positionNotional > maxAllowedNotional) {
      return {
        allowed: false,
        reason: `Position too large: $${positionNotional.toFixed(2)} > max $${maxAllowedNotional.toFixed(2)} (${this.maxPositionPctOfBalance}x balance)`,
        debug: { riskAmount, stopDistancePct, positionNotional, leverage },
      };
    }

    if (requiredMargin > balance) {
      return {
        allowed: false,
        reason: `Required margin $${requiredMargin.toFixed(2)} exceeds balance $${balance.toFixed(2)}`,
        debug: { positionNotional, leverage, requiredMargin },
      };
    }

    return {
      allowed: true,
      reason: null,
      positionSize, // в BTC
      positionNotional, // в USDT (полный размер)
      requiredMargin, // в USDT (что заблокирует биржа)
      leverage,
      riskAmount, // ожидаемый убыток при SL
      balance,
    };
  }
}
