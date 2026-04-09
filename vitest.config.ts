import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/eval/**'],
    // Integration tests gated by env var; default excludes them
    env: {
      OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0',
    },
  },
});
