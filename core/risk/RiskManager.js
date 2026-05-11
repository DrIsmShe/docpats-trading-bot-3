/**
 * RiskManager — единственное место в системе, где принимается решение
 * "торговать или нет" и "сколько именно".
 *
 * ВАЖНО: правильно учитывает ПЛЕЧО. Это та самая ошибка которая убила
 * серверный бот: расчёт без leverage давал размер позиции в 10 раз больше
 * планового риска при использовании x10 фьючерсов.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ДВА РЕЖИМА РАСЧЁТА:
 *
 * 1. RISK-BASED (классический):
 *    Размер позиции рассчитывается так, чтобы при срабатывании SL
 *    мы потеряли ровно riskPerTrade × balance (например 1%).
 *    Используется по умолчанию.
 *
 * 2. FIXED-SIZE:
 *    Размер задан стратегией через signal.meta.fixedSize.
 *    RiskManager использует его как positionSize, но ВСЁ РАВНО валидирует:
 *      - notional не ниже minPositionUSDT
 *      - notional не выше maxPositionPctOfBalance × balance
 *      - requiredMargin не превышает balance
 *    Если валидация падает — сделка блокируется.
 *
 *    Используется Confluence стратегией, где размер = baseline × ML multiplier
 *    задаётся как конкретное число (0.002 BTC, 0.02 ETH и т.д.), а не как
 *    % от баланса.
 * ─────────────────────────────────────────────────────────────────────
 *
 * ФОРМУЛА RISK-BASED режима:
 *   1. riskAmount = balance * riskPerTrade
 *   2. stopDistancePct = |entry - stopLoss| / entry
 *   3. positionNotional = riskAmount / stopDistancePct
 *   4. positionSize = positionNotional / entry
 *   5. requiredMargin = positionNotional / leverage
 *
 * ФОРМУЛА FIXED-SIZE режима:
 *   1. positionSize = signal.meta.fixedSize
 *   2. positionNotional = positionSize * entry
 *   3. requiredMargin = positionNotional / leverage
 *   4. riskAmount = |entry - stopLoss| * positionSize  (потенциальная потеря)
 *
 * ПЛЕЧО НЕ ВХОДИТ в формулу размера позиции — только в маржу.
 * Плечо позволяет экономить капитал, не увеличивая риск на сделку.
 * ─────────────────────────────────────────────────────────────────────
 */
export class RiskManager {
  constructor({
    riskPerTrade = 0.01, // 1% от баланса на сделку (RISK-BASED mode)
    minBalance = 10,
    maxPositionPctOfBalance = 5, // максимум 5x от баланса (страховка)
    minPositionUSDT = 5, // меньше — биржа отвергнет
  } = {}) {
    this.riskPerTrade = riskPerTrade;
    this.minBalance = minBalance;
    this.maxPositionPctOfBalance = maxPositionPctOfBalance;
    this.minPositionUSDT = minPositionUSDT;
  }

  /**
   * Применить риск-менеджмент к торговому сигналу (high-level, для TradingEngine).
   *
   * Сам выбирает режим:
   *   - есть signal.meta.fixedSize → FIXED-SIZE mode
   *   - иначе                       → RISK-BASED mode
   */
  apply(signal, context) {
    if (!signal) {
      return { allowed: false, reason: "No signal" };
    }
    if (!signal.entry || !signal.stopLoss || !signal.takeProfit) {
      return { allowed: false, reason: "Signal missing entry/SL/TP" };
    }

    if (context.positions?.hasOpenPosition) {
      return {
        allowed: false,
        reason: "Position already open for this symbol",
      };
    }

    const balance = context.balances?.futures ?? 0;
    if (balance < this.minBalance) {
      return {
        allowed: false,
        reason: `Balance too low: $${balance.toFixed(2)} < $${this.minBalance}`,
      };
    }

    // Профиль риска от стратегии (leverage)
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
   * Низкоуровневый интерфейс — для server.js / кастомных вызовов без context.
   */
  buildPlan({ signal, balance, leverage = 1 }) {
    if (!signal) return { allowed: false, reason: "No signal" };
    if (!signal.entry || !signal.stopLoss) {
      return { allowed: false, reason: "Signal missing entry/stopLoss" };
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
   * Главный диспетчер — выбирает режим по наличию signal.meta.fixedSize.
   */
  _compute({ signal, balance, leverage }) {
    const fixedSize = signal?.meta?.fixedSize;

    if (typeof fixedSize === "number" && fixedSize > 0) {
      return this._computeFixedSize({ signal, balance, leverage, fixedSize });
    }

    return this._computeFromRisk({ signal, balance, leverage });
  }

  /**
   * RISK-BASED: размер рассчитывается из расстояния до SL и riskPerTrade.
   */
  _computeFromRisk({ signal, balance, leverage }) {
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

    const riskAmount = balance * this.riskPerTrade;
    const positionNotional = riskAmount / stopDistancePct;
    const positionSize = positionNotional / entry;
    const requiredMargin = positionNotional / leverage;

    const validation = this._validate({
      positionNotional,
      requiredMargin,
      balance,
      leverage,
    });
    if (!validation.allowed) return validation;

    return {
      allowed: true,
      reason: null,
      positionSize,
      positionNotional,
      requiredMargin,
      leverage,
      riskAmount,
      balance,
      sizingMode: "risk_based",
    };
  }

  /**
   * FIXED-SIZE: размер задан стратегией. RiskManager только валидирует.
   *
   * riskAmount здесь — это ПОТЕНЦИАЛЬНАЯ потеря при SL, а не таргет.
   * Стратегия сама отвечает за то, чтобы fixedSize × stopDistance не был
   * катастрофическим относительно баланса.
   */
  _computeFixedSize({ signal, balance, leverage, fixedSize }) {
    const entry = signal.entry;
    const stopLoss = signal.stopLoss;
    const stopDistance = Math.abs(entry - stopLoss);

    if (stopDistance <= 0) {
      return {
        allowed: false,
        reason: "Invalid stop distance (zero or negative)",
      };
    }

    const positionSize = fixedSize;
    const positionNotional = positionSize * entry;
    const requiredMargin = positionNotional / leverage;
    const riskAmount = stopDistance * positionSize;

    const validation = this._validate({
      positionNotional,
      requiredMargin,
      balance,
      leverage,
    });
    if (!validation.allowed) return validation;

    // Дополнительная проверка для fixed-size: если потенциальная потеря
    // больше 5% баланса — это перебор, блокируем. (Защита от человеческой
    // ошибки в config.positionSize.)
    const maxAllowedRisk = balance * 0.05;
    if (riskAmount > maxAllowedRisk) {
      return {
        allowed: false,
        reason: `fixed_size_risk_too_high: $${riskAmount.toFixed(2)} > 5% of balance ($${maxAllowedRisk.toFixed(2)})`,
        debug: { positionSize, stopDistance, riskAmount, balance },
      };
    }

    return {
      allowed: true,
      reason: null,
      positionSize,
      positionNotional,
      requiredMargin,
      leverage,
      riskAmount,
      balance,
      sizingMode: "fixed_size",
    };
  }

  /**
   * Общие валидации для обоих режимов: notional, margin, max position.
   */
  _validate({ positionNotional, requiredMargin, balance, leverage }) {
    if (positionNotional < this.minPositionUSDT) {
      return {
        allowed: false,
        reason: `Position too small: $${positionNotional.toFixed(2)} < $${this.minPositionUSDT}`,
        debug: { positionNotional },
      };
    }

    const maxAllowedNotional = balance * this.maxPositionPctOfBalance;
    if (positionNotional > maxAllowedNotional) {
      return {
        allowed: false,
        reason: `Position too large: $${positionNotional.toFixed(2)} > max $${maxAllowedNotional.toFixed(2)} (${this.maxPositionPctOfBalance}x balance)`,
        debug: { positionNotional, leverage },
      };
    }

    if (requiredMargin > balance) {
      return {
        allowed: false,
        reason: `Required margin $${requiredMargin.toFixed(2)} exceeds balance $${balance.toFixed(2)}`,
        debug: { positionNotional, leverage, requiredMargin },
      };
    }

    return { allowed: true };
  }
}
