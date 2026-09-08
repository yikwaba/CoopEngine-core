import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok status with service identity', () => {
    const controller = new HealthController();
    const result = controller.getHealth();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('coopengine-api');
    expect(Number.isNaN(Date.parse(result.time))).toBe(false);
  });
});
