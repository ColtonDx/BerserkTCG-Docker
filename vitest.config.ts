import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@berserk/engine': new URL('./packages/engine/src/index.ts', import.meta.url).pathname,
      '@berserk/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
    },
  },
});
