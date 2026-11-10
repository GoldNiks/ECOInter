/** Fixed-point decimal arithmetic (8 fractional digits) backed by bigint. */
export const MONEY_SCALE = 100_000_000n;
const SCALE_DIGITS = 8;

export function money(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value * MONEY_SCALE;
  const raw = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid monetary value: ${raw}`);
  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > SCALE_DIGITS) {
    const kept = fraction.slice(0, SCALE_DIGITS);
    const dropped = fraction.slice(SCALE_DIGITS);
    if (/[1-9]/.test(dropped)) throw new Error(`More than ${SCALE_DIGITS} decimal places: ${raw}`);
    return (negative ? -1n : 1n) * (BigInt(whole) * MONEY_SCALE + BigInt((kept + '0'.repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS)));
  }
  const scaled = BigInt(whole) * MONEY_SCALE + BigInt((fraction + '0'.repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS));
  return negative ? -scaled : scaled;
}

export function moneyString(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function add(a: bigint, b: bigint): bigint { return a + b; }
export function sub(a: bigint, b: bigint): bigint { return a - b; }
export function mulInt(a: bigint, n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new Error('Quantity must be a safe integer');
  return a * BigInt(n);
}
export function mul(a: bigint, b: bigint): bigint { return (a * b) / MONEY_SCALE; }
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('Division by zero');
  return (a * MONEY_SCALE) / b;
}
export function divInt(a: bigint, n: number): bigint {
  if (!Number.isSafeInteger(n) || n === 0) throw new Error('Invalid divisor');
  return a / BigInt(n);
}
export function portion(total: bigint, part: number, whole: number): bigint {
  if (whole <= 0 || part < 0 || part > whole) throw new Error('Invalid quantity portion');
  return part === whole ? total : (total * BigInt(part)) / BigInt(whole);
}
export function percentOf(amount: bigint, percent: bigint): bigint { return mul(amount, percent); }
export function floorUnits(balance: bigint, perUnit: bigint): number {
  if (perUnit <= 0n) return 0;
  const units = balance / perUnit;
  return units > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(units);
}
export function compareUnitPrice(aTotal: bigint, aQty: number, bTotal: bigint, bQty: number): number {
  const left = aTotal * BigInt(bQty);
  const right = bTotal * BigInt(aQty);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function ratioPercent(profit: bigint, capital: bigint): bigint {
  if (capital <= 0n) return 0n;
  return div(mulInt(profit, 100), capital);
}
export function maxBigInt(a: bigint, b: bigint): bigint { return a > b ? a : b; }
