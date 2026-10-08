import {BadRequestException} from '@nestjs/common';
import {ValidatorConstraint,ValidatorConstraintInterface} from 'class-validator';
import {moneyKobo} from '../common/money';

/** SQL SUM(NUMERIC) may exceed an individual NUMERIC(19,2) column. */
export function ledgerKobo(value:string):bigint {
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new BadRequestException('Invalid ledger decimal');
 const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');
 const amount=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
 return negative?-amount:amount;
}
export function ledgerDecimal(value:bigint):string {
 const absolute=value<0n?-value:value;
 return `${value<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}
@ValidatorConstraint({name:'journalAmount',async:false})
export class JournalAmountValidator implements ValidatorConstraintInterface {
 validate(value:unknown):boolean {
  if(typeof value!=='number'&&typeof value!=='string') return false;
  try{return moneyKobo(value)>0n;}catch{return false;}
 }
 defaultMessage():string {return 'Journal amount must be positive with at most two decimal places; use a decimal string above the supported number range';}
}
