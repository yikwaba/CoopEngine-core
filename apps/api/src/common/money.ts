import { BadRequestException } from '@nestjs/common';
/** NUMERIC(19,2), expressed as integer kobo. No binary floating-point math. */
const MAX_KOBO = 10n ** 19n - 1n;
export const MAX_NUMERIC_MONEY_INPUT = 100_000_000_000;
export function moneyKobo(value: string | number): bigint {
  // Existing JSON-number clients are supported within the established money
  // input bound. Larger database values must remain decimal strings.
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > MAX_NUMERIC_MONEY_INPUT)) {
    throw new BadRequestException('Money number exceeds the supported input range');
  }
  const text=String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new BadRequestException('Money must have at most two decimal places');
  const negative=text.startsWith('-'),unsigned=negative?text.slice(1):text;
  const [whole,fraction='']=unsigned.split('.');
  const kobo=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
  if(kobo>MAX_KOBO)throw new BadRequestException('Money exceeds NUMERIC(19,2)');
  return negative?-kobo:kobo;
}
export function moneyDecimal(kobo: bigint): string {
  const negative=kobo<0n,absolute=negative?-kobo:kobo;
  if(absolute>MAX_KOBO)throw new BadRequestException('Money exceeds NUMERIC(19,2)');
  return `${negative?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}
/** Non-negative fixed-point rate/multiplier, retaining database decimal precision. */
export function decimalRatio(value: string, places: number): {numerator:bigint;denominator:bigint} {
  if(!Number.isInteger(places)||places<0||places>4)throw new BadRequestException('Unsupported decimal precision');
  if(!new RegExp(`^\\d+(?:\\.\\d{1,${places||1}})?$`).test(value))throw new BadRequestException('Invalid non-negative decimal');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>places)throw new BadRequestException('Too many decimal places');
  const denominator=10n**BigInt(places);
  return {numerator:BigInt(whole!)*denominator+BigInt(fraction.padEnd(places,'0')||'0'),denominator};
}
/** Half-up for non-negative amounts, matching PostgreSQL numeric round(). */
export function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  if(numerator<0n||denominator<=0n)throw new BadRequestException('Invalid non-negative financial ratio');
  return (numerator+denominator/2n)/denominator;
}
export function loanCeiling(savings: string, multiplier: string): bigint {
  const balance=moneyKobo(savings),ratio=decimalRatio(multiplier,2);
  if(balance<0n)throw new BadRequestException('Qualifying savings cannot be negative');
  return roundedRatio(balance*ratio.numerator,ratio.denominator);
}
export function flatLoanInstallments(principal: string, rate: string, months: number): {principal:string;interest:string}[] {
  if(!Number.isInteger(months)||months<1||months>60)throw new BadRequestException('Loan term must be 1..60 months');
  const totalP=moneyKobo(principal),ratio=decimalRatio(rate,4);
  if(totalP<=0n||ratio.numerator>9_999_999n)throw new BadRequestException('Invalid loan principal or rate');
  const totalI=roundedRatio(totalP*ratio.numerator*BigInt(months),1200n*ratio.denominator);
  moneyDecimal(totalI); // Validate before any schedule row is persisted.
  const count=BigInt(months),baseP=totalP/count,baseI=totalI/count;
  return Array.from({length:months},(_,index)=>({
    principal:moneyDecimal(index===months-1?totalP-baseP*(count-1n):baseP),
    interest:moneyDecimal(index===months-1?totalI-baseI*(count-1n):baseI),
  }));
}
