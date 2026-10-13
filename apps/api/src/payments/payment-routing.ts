export interface RoutingIntent {id:string;member_id:string;reference:string;purpose:string;status:string}
/** References are quoted in narration, as complete tokens; payer names never identify an intent. */
export function quotedIntentReference(narration:string,reference:string):boolean{
 if(!reference.trim())return false;
 const escaped=reference.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`,'iu').test(narration);
}
export function resolvePaymentRoute(narration:string,virtualMemberId:string|null,intents:readonly RoutingIntent[]):{
 memberId:string|null;intent:RoutingIntent|null;reason:string|null;
}{
 const quoted=intents.filter(i=>quotedIntentReference(narration,i.reference));
 const parked=(reason:string,memberId=virtualMemberId,intent:RoutingIntent|null=null)=>({memberId,intent,reason});
 if(quoted.length>1)return parked('Multiple payment intent references were quoted; explicit allocation is required');
 const selected=quoted[0];
 if(selected){
  if(virtualMemberId&&selected.member_id!==virtualMemberId)return parked('Virtual account and payment intent identify different members; explicit allocation is required',null);
  if(!['SAVINGS_DEPOSIT','LOAN_REPAYMENT','SHARE_PURCHASE'].includes(selected.purpose))return parked('Payment intent purpose requires reconciliation',selected.member_id,selected);
  if(!['OPEN','PARTIAL'].includes(selected.status))return parked('Quoted payment intent is not open; explicit review is required',selected.member_id,selected);
  return {memberId:selected.member_id,intent:selected,reason:null};
 }
 if(/\bCOOP-[\p{L}\p{N}_-]+/iu.test(narration))return parked('Payment intent reference was not found in this cooperative; explicit allocation is required');
 if(!virtualMemberId)return parked('No member matched and no complete intent reference was quoted',null);
 if(intents.some(i=>i.member_id===virtualMemberId&&['OPEN','PARTIAL'].includes(i.status)))return parked('An open payment intent exists but its reference was not quoted; explicit allocation is required');
 if(/\b(?:loan|repay(?:ments?)?|instal(?:l)?ments?|shares?|dividends?)\b/iu.test(narration))return parked('Payment purpose requires an explicit intent reference or staff allocation');
 // Preserve unreferenced savings receipts to a unique virtual account when no open intent competes.
 return {memberId:virtualMemberId,intent:null,reason:null};
}
