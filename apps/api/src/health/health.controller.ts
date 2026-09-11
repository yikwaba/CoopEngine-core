import { Controller, Get, Injectable, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';

export interface HealthStatus {
  status: 'ok';
  service: string;
  version: string;
  time: string;
}

export type ProviderMode = 'dev' | 'live';

export interface ProviderStatus {
  /** dev = simulated locally; live = a real provider is configured. */
  mode: ProviderMode;
  /** Which provider implementation is selected. */
  provider: string;
  /** Environment variables this provider needs (names only — never values). */
  requiredEnv: string[];
  /** Of those, which are currently missing. */
  missingEnv: string[];
  /** What to run to finish the integration. */
  enableWith: string;
  /** What is simulated while this provider is in dev mode. */
  devBehaviour: string;
  /** Features that cannot go live until this provider is configured. */
  blocks: string[];
}

export interface ProviderStatusReport {
  generatedAt: string;
  providers: { sms: ProviderStatus; email: ProviderStatus; payments: ProviderStatus };
  /** Things that are fine for a pilot but must not reach real members. */
  warnings: string[];
  /** True when nothing is simulated that would harm a real member. */
  readyForRealMembers: boolean;
}

const present = (name: string): boolean =>
  (process.env[name] ?? '').trim().length > 0;

/**
 * Reports how each external integration is configured — the "are we provisioned?"
 * answer for operators and for whoever integrates a provider later.
 *
 * Deliberately reports only *presence* of credentials, never their values, and is
 * behind auth + permissions because "payments are live" is useful to an attacker.
 */
@Injectable()
export class ProviderStatusService {
  report(): ProviderStatusReport {
    const smsProvider =
      (process.env.MEMBER_OTP_PROVIDER ?? 'dev').toLowerCase() === 'termii'
        ? 'termii'
        : 'dev';
    const smsRequired = ['TERMII_API_KEY', 'TERMII_SENDER_ID'];
    const smsMissing = smsRequired.filter((k) => !present(k));
    const sms: ProviderStatus = {
      mode: smsProvider === 'termii' && smsMissing.length === 0 ? 'live' : 'dev',
      provider: smsProvider,
      requiredEnv: smsRequired,
      missingEnv: smsMissing,
      enableWith: 'scripts/provider-set-key.sh  →  scripts/provider-preflight.sh --require  →  scripts/provider-switch.sh termii',
      devBehaviour:
        'OTP codes are returned in the API response as devCode and logged; no message is sent',
      blocks: ['member self-service login at scale (each member needs a real SMS OTP)'],
    };

    const smtpRequired = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
    const smtpMissing = smtpRequired.filter((k) => !present(k));
    const email: ProviderStatus = {
      mode: smtpMissing.length === 0 ? 'live' : 'dev',
      provider: smtpMissing.length === 0 ? 'smtp' : 'dev (recorder)',
      requiredEnv: smtpRequired,
      missingEnv: smtpMissing,
      enableWith: 'scripts/smtp-configure.sh   (Brevo: smtp-relay.brevo.com:587)',
      devBehaviour:
        'notifications are recorded with status FAILED and the provider error; no mail is sent',
      blocks: [],
    };

    const monnifySelected =
      (process.env.MONNIFY_PROVIDER ?? 'dev').toLowerCase() === 'monnify';
    const payRequired = ['MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE'];
    const payMissing = payRequired.filter((k) => !present(k));
    const payments: ProviderStatus = {
      mode: monnifySelected && payMissing.length === 0 ? 'live' : 'dev',
      provider: monnifySelected ? 'monnify' : 'dev',
      requiredEnv: payRequired,
      missingEnv: payMissing,
      enableWith: 'scripts/provider-set-key.sh  →  scripts/provider-preflight.sh --require  →  scripts/provider-switch.sh monnify',
      devBehaviour:
        'gateway checkout and webhook collection are simulated; staff record contributions and repayments manually and reconcile them in-app',
      blocks: ['automatic collection of member contributions and loan repayments from bank/mobile money'],
    };

    const warnings: string[] = [];
    if (sms.mode === 'dev') {
      warnings.push(
        'SMS OTP is simulated: the code comes back in the API response. Safe for a pilot with known test members; do not onboard real members until Termii is configured.',
      );
    }
    if (email.mode === 'dev') {
      warnings.push(
        'Email is not delivered (recorded only). Statements, receipts and reminders are produced as PDFs for staff to hand out instead.',
      );
    }
    if (payments.mode === 'dev') {
      warnings.push(
        'No payment gateway: member contributions are recorded manually by staff. The ledger, balances and reports remain correct — only the automatic bank/mobile-money collection is missing.',
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      providers: { sms, email, payments },
      warnings,
      // Only real OTP delivery is a hard blocker for real members.
      readyForRealMembers: sms.mode === 'live',
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly providerStatus: ProviderStatusService) {}

  @Get()
  getHealth(): HealthStatus {
    return {
      status: 'ok',
      service: 'coopengine-api',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  }

  /** Integration readiness — auth required, values never exposed. */
  @Get('providers')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('settings.manage')
  getProviders(): ProviderStatusReport {
    return this.providerStatus.report();
  }
}
