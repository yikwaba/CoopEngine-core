import { Controller, Get } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: string;
  version: string;
  time: string;
}

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthStatus {
    return {
      status: 'ok',
      service: 'coopengine-api',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
