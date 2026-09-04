import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'lib/**/*.test.ts'],
    // Redirects the real ~/.ace state — session locks AND the
    // mobile-backend toggle file — to a per-worker tempdir, so `npm test`
    // can never reap or pollute another live session's state, and workers
    // cannot contaminate each other through it. ace#1704 / #1883 / #1797.
    setupFiles: ['test/setup/isolate-ace-home-state.ts'],
    exclude: ['test/eval/**'],
    // Integration tests gated by env var; default excludes them
    env: {
      OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0',
    },
  },
});
