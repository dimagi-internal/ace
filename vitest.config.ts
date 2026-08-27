import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'lib/**/*.test.ts'],
    // Redirects ~/.ace/sessions to a per-worker tempdir so `npm test`
    // can never reap or pollute another live session's mobile locks.
    // ace#1704.
    setupFiles: ['test/setup/isolate-session-locks.ts'],
    exclude: ['test/eval/**'],
    // Integration tests gated by env var; default excludes them
    env: {
      OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0',
    },
  },
});
