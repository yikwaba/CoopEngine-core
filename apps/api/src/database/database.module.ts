import { Global, Module } from '@nestjs/common';
import { createPool } from '@coopengine/db';
import { Pool } from 'pg';

export const DB_POOL = Symbol('DB_POOL');

export interface DbPoolProvider {
  provide: symbol;
  useFactory: () => Pool;
}

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: () => createPool(process.env.DATABASE_URL),
    } satisfies DbPoolProvider,
  ],
  exports: [DB_POOL],
})
export class DatabaseModule {}
