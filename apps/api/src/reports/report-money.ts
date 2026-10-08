import {ledgerKobo,ledgerDecimal} from '../ledger/ledger-money';

/** Monetary NUMERIC values and SUMs: never narrow an aggregate to a column. */
export function reportDecimal(value:unknown):string {
 return ledgerDecimal(ledgerKobo(String(value??'0')));
}
export function reportSum<T>(rows:readonly T[],field:keyof T):string {
 return ledgerDecimal(rows.reduce((sum,row)=>sum+ledgerKobo(reportDecimal(row[field])),0n));
}
export function reportMoney(value:unknown):string {
 const decimal=reportDecimal(value),negative=decimal.startsWith('-');
 const [whole,fraction]=(negative?decimal.slice(1):decimal).split('.');
 return `${negative?'-':''}₦${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction}`;
}
