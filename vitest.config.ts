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
    // 20 test files spawn REAL subprocesses (`node:child_process`) — the
    // version-bump script, the doctor probe, lock holders, hook guards,
    // schema dumpers. None of them declared a timeout, so all 20 ran under
    // vitest's 5000ms default, which is not a meaningful bound on process
    // startup: it measures how busy the box is, not whether the code works.
    //
    // Under a saturated box they time out and the suite goes red on tests
    // that pass in isolation. Measured on main @ 7336f2f0 with two full
    // suites running concurrently, 6 runs: 10 failures across
    // session-lock-e2e (5), version-bump (4) and run-xform-patch (1), every
    // one of them `Error: Test timed out in 5000ms` at 5003-5699ms — i.e.
    // just over the line, never far past it. ace#1912.
    //
    // 30s is ~6x the worst observed and still a real bound: a genuinely
    // hung test fails, just later. The whole suite runs in ~19s, so the
    // cost of the higher ceiling is paid only when something is already
    // broken. hookTimeout matters too — beforeEach/afterEach in these files
    // spawn as well, and its default is 10000ms.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests gated by env var; default excludes them
    env: {
      OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0',
    },
  },
});
