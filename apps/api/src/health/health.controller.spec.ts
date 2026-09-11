import { describe, it, expect } from 'vitest';
import { HealthController, ProviderStatusService } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController(new ProviderStatusService());

  it('reports ok status with service identity', () => {
    const result = controller.getHealth();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('coopengine-api');
    expect(Number.isNaN(Date.parse(result.time))).toBe(false);
  });

  it('reports provider readiness without exposing any credential value', () => {
    const report = controller.getProviders();
    expect(Object.keys(report.providers).sort()).toEqual(['email', 'payments', 'sms']);
    // With no provider credentials in the test environment every channel is dev mode.
    expect(report.providers.sms.mode).toBe('dev');
    expect(report.providers.email.mode).toBe('dev');
    expect(report.providers.payments.mode).toBe('dev');
    // Only env var NAMES are ever listed, never values.
    const serialized = JSON.stringify(report);
    expect(serialized).toContain('TERMII_API_KEY');
    expect(serialized).not.toMatch(/sk_live|MK_PROD|xkeysib-/);
    expect(report.readyForRealMembers).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
