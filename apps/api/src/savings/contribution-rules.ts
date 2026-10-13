import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {PoolClient} from 'pg';
import {moneyDecimal,moneyKobo} from '../common/money';

/** Member first, then account/product: common order for payroll, provider and manual posting. */
export async function lockActiveSavingsMember(c:PoolClient,orgId:string,memberId:string):Promise<void>{
 const member=await c.query('SELECT status FROM members WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE',[orgId,memberId]);
 if(!member.rows[0])throw new NotFoundException('Member not found');
 if(member.rows[0].status!=='ACTIVE')throw new ConflictException('Member is not active');
}
/** Applies to the amount actually credited to this product in one posting. */
export async function checkSavingsContribution(c:PoolClient,orgId:string,productId:string,value:bigint):Promise<void>{
 const product=await c.query('SELECT status,min_deposit FROM savings_products WHERE organization_id=$1 AND id=$2 FOR SHARE',[orgId,productId]);
 if(!product.rows[0])throw new NotFoundException('Savings product not found');
 if(product.rows[0].status!=='ACTIVE')throw new ConflictException('Savings product is not active');
 const minimum=moneyKobo(product.rows[0].min_deposit);
 if(minimum<0n)throw new ConflictException('Savings product minimum is invalid');
 if(value<=0n)throw new BadRequestException('Invalid savings contribution');
 if(value<minimum)throw new BadRequestException(`Minimum deposit is ${moneyDecimal(minimum)}; requested ${moneyDecimal(value)}`);
}
