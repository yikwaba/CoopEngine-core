import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * NestJS relies on design:paramtypes decorator metadata for DI, which esbuild
 * does not emit. unplugin-swc transforms TS with SWC and emits the metadata.
 */
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
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['node_modules/**', '**/*.integration.spec.ts', 'test/**/*.integration.spec.ts'],
  },
});
