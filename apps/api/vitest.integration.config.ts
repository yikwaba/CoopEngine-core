import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/** Integration config: real-Postgres suites (excluded from the unit run). */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.integration.spec.ts'],
    fileParallelism: false,
    // Cloud databases (Supabase) add ~100ms+ per round-trip; local runs finish
    // in milliseconds so a generous cap costs nothing.
    testTimeout: Number(process.env.VITEST_TEST_TIMEOUT ?? 30_000),
    hookTimeout: Number(process.env.VITEST_HOOK_TIMEOUT ?? 30_000),
  },
});
