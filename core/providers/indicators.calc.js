/**
 * Чистые функции расчёта технических индикаторов.
 *
 * Все функции принимают массивы и возвращают массивы той же длины
 * (или короче, если индикатор требует "разогрева" — например EMA20
 * не имеет смысла для первых 19 свечей).
 *
 * Это сознательное решение НЕ использовать стороннюю библиотеку:
 *   - Меньше зависимостей
 *   - Полный контроль над формулами
 *   - Легко тестировать
 *   - Знаем что внутри происходит
 */

/**
 * Exponential Moving Average.
 * EMA(t) = price(t) * k + EMA(t-1) * (1 - k), где k = 2 / (period + 1)
 */
export function calcEMA(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  if (period <= 0) throw new Error("calcEMA: period must be > 0");

  const k = 2 / (period + 1);
  const result = [];
  let ema = values[0];

  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      ema = values[0];
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }

  return result;
}

/**
 * Relative Strength Index (классический RSI Уайлдера).
 * Возвращает массив той же длины, первые `period` значений = 50 (нейтральная заглушка).
 */
export function calcRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const result = new Array(values.length).fill(50);
  if (values.length < period + 1) return result;

  // Первая инициализация — простое среднее
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Дальше — экспоненциальное сглаживание (формула Уайлдера)
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * Average True Range.
 * TR(t) = max(high - low, |high - prevClose|, |low - prevClose|)
 * ATR — экспоненциальное сглаживание TR.
 */
export function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const result = new Array(candles.length).fill(0);
  if (candles.length < 2) return result;

  // Считаем массив True Range
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }

  if (candles.length < period) {
    // Недостаточно данных — заполним TR-ами
    for (let i = 0; i < candles.length; i++) {
      result[i] = trs[i];
    }
    return result;
  }

  // Первая ATR = простое среднее первых period TR
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  result[period - 1] = atr;

  // Дальше — сглаживание Уайлдера
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result[i] = atr;
  }

  return result;
}
