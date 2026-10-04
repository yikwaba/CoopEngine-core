import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SENSITIVE_ACTION } from '../src/auth/sensitive-action';
import { LedgerController } from '../src/ledger/ledger.controller';
import { LoansController } from '../src/loans/loans.controller';
import { SavingsController } from '../src/savings/savings.controller';
import { SharesController } from '../src/shares/shares.controller';
import { PayrollController } from '../src/payroll/payroll.controller';
import { ApprovalsController } from '../src/approvals/approvals.controller';
import { DividendsController } from '../src/dividends/dividends.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { BulkController } from '../src/bulk/bulk.controller';
import { SettingsController } from '../src/settings/settings.controller';
import { OrgUsersController } from '../src/org-users/org-users.controller';
const controllers=[LedgerController,LoansController,SavingsController,SharesController,PayrollController,ApprovalsController,DividendsController,PaymentsController,BulkController,SettingsController,OrgUsersController];
const exemptions:Record<string,string>={
'LedgerController.createJournal':'Unposted draft','LedgerController.submit':'Unposted submission','LedgerController.createPeriod':'Open period creation',
'LoansController.apply':'Unapproved application','LoansController.markDefaults':'Arrears status only','LoansController.addGuarantor':'Application preparation','LoansController.reject':'Rejects without posting',
'SavingsController.openAccount':'Zero-balance account','SavingsController.rejectWithdrawal':'Rejects without posting',
'PayrollController.preview':'Unposted preview','PayrollController.commit':'Submits for protected approval','PayrollController.reject':'Rejects without posting',
'ApprovalsController.createRequest':'Unapproved request','ApprovalsController.rejectPayroll':'Rejects without posting',
'PaymentsController.webhook':'Separate provider-signature boundary','PaymentsController.createVirtualAccount':'Provisioning; provider review remains open','PaymentsController.createIntent':'Unsettled intent','PaymentsController.cancelIntent':'Unsettled cancellation',
'BulkController.sharePreview':'Unposted preview','BulkController.loanPreview':'Unposted preview',
};
describe('reviewed sensitive-action route inventory',()=>{
 it('every mutation has verification or an explicit exemption, including approval aliases',()=>{
  let count=0;const used=new Set<string>();
  for(const controller of controllers)for(const name of Object.getOwnPropertyNames(controller.prototype)){
   if(name==='constructor')continue;
   const handler=controller.prototype[name as keyof typeof controller.prototype];
   if(typeof handler!=='function'||Reflect.getMetadata(PATH_METADATA,handler)===undefined||Reflect.getMetadata(METHOD_METADATA,handler)===RequestMethod.GET)continue;
   const key=`${controller.name}.${name}`;
   if(Reflect.getMetadata(SENSITIVE_ACTION,handler)){count++;expect(exemptions[key],key).toBeUndefined();}
   else{expect(exemptions[key],key).toBeTruthy();used.add(key);}
  }
  expect(count).toBe(29);expect([...used].sort()).toEqual(Object.keys(exemptions).sort());
 });
});
