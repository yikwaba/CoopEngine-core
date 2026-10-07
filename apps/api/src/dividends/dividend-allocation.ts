import { BadRequestException } from '@nestjs/common';
import { moneyDecimal, moneyKobo, roundedRatio } from '../common/money';

/** Preserve half-up pro-rata rounding and drift on the largest holder (input order breaks ties).
 * Refuse unsafe negative drift instead of silently introducing a different allocation policy. */
export function allocateDividends(amount: number, shares: string[]): {total:bigint;totalShares:bigint;amounts:bigint[]} {
 const total=moneyKobo(amount),balances=shares.map(moneyKobo);
 if(total<=0n) throw new BadRequestException('distributableAmount must be greater than zero');
 if(!balances.length || balances.some(x=>x<=0n)) throw new BadRequestException('No members hold share capital — nothing to distribute');
 const totalShares=balances.reduce((a,b)=>a+b,0n);
 const amounts=balances.map(balance=>roundedRatio(total*balance,totalShares));
 const drift=total-amounts.reduce((a,b)=>a+b,0n);
 let biggest=0;
 for(let i=1;i<balances.length;i++) if(balances[i]!>balances[biggest]!) biggest=i;
 amounts[biggest]=amounts[biggest]!+drift;
 if(amounts.some(x=>x<0n)) throw new BadRequestException('This distribution would create a negative allocation under the existing rounding policy; an approved allocation policy is required');
 if(amounts.reduce((a,b)=>a+b,0n)!==total) throw new BadRequestException('Dividend allocations do not conserve the total');
 amounts.forEach(moneyDecimal);
 return {total,totalShares,amounts};
}
