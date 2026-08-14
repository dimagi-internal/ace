/**
 * Which runner does this `/ace:iterate` campaign actually use, and did anyone
 * say so out loud?
 *
 * Why this exists (dimagi-internal/ace#1276 item 3). `commands/iterate.md`
 * documents `--runner web|local` as **"default `web`; the observable
 * runner"**, and `iterate-loop.md` prefers web for the same reason. But a
 * resumed campaign reads `runner` out of `iterate-state.yaml`, so an inherited
 * `runner: local` — carried in from an ARCHIVED campaign — silently selected
 * the failure-prone path with no warning, even on a fresh `--new-golden` lock.
 *
 * The runner documented as *the* observable one is the one you don't get.
 *
 * On the bednet campaign (2026-08-14, plugin 0.13.790) that cost two dead
 * iteration attempts and ~50 minutes of Nova/HQ work stranded: one 41-minute
 * run whose entire log was the 15 bytes `Execution error`, and one killed by
 * the operator's session limit after nine minutes of real work with artifacts
 * already written to Drive.
 *
 * Precedence, in order:
 *
 *  1. an explicit `--runner` — always wins, silently, because the operator
 *     just said what they wanted;
 *  2. `--new-golden` — takes the DEFAULT and says it is discarding the
 *     archived value. A new lock is a new campaign; inheriting a runner from
 *     an archived one is how this bug happened;
 *  3. `iterate-state.yaml` on a resume — honoured, but WARNED when it
 *     diverges from the default, so the choice is visible in the campaign log;
 *  4. the default.
 *
 * Every result carries `source`, so which rule fired is auditable after the
 * fact rather than reconstructed.
 */

export type IterateRunner = 'web' | 'local';

/** The observable runner. `local` is opaque without `bin/ace-run-supervise`. */
export const DEFAULT_RUNNER: IterateRunner = 'web';

const RUNNERS: IterateRunner[] = ['web', 'local'];

export interface RunnerResolution {
  runner: IterateRunner;
  source: 'cli' | 'iterate-state' | 'default';
  warning?: string;
}

export interface RunnerInputs {
  /** `--runner` as passed on the command line. */
  cliRunner?: IterateRunner;
  /** `runner:` as read from `ACE/<opp>/iterate-state.yaml`. */
  stateRunner?: IterateRunner;
  /** True when `--new-golden` is minting a fresh campaign. */
  isNewGolden?: boolean;
}

function assertRunner(value: string | undefined, where: string): IterateRunner | undefined {
  if (value === undefined) return undefined;
  if (!RUNNERS.includes(value as IterateRunner)) {
    throw new Error(
      `invalid runner "${value}" from ${where} — expected one of ${RUNNERS.join(' | ')}. ` +
        'Falling back to a default here would reproduce ace#1276: a runner nobody chose.',
    );
  }
  return value as IterateRunner;
}

export function resolveRunner(inputs: RunnerInputs): RunnerResolution {
  const cli = assertRunner(inputs.cliRunner, '--runner');
  const state = assertRunner(inputs.stateRunner, 'iterate-state.yaml');

  if (cli) return { runner: cli, source: 'cli' };

  if (inputs.isNewGolden) {
    const warning =
      state && state !== DEFAULT_RUNNER
        ? `--new-golden mints a fresh campaign, so runner falls back to the documented default ` +
          `'${DEFAULT_RUNNER}' rather than inheriting '${state}' from the archived iterate-state.yaml ` +
          `(ace#1276). Pass --runner ${state} if you really want it.`
        : undefined;
    return { runner: DEFAULT_RUNNER, source: 'default', warning };
  }

  if (state) {
    const warning =
      state !== DEFAULT_RUNNER
        ? `runner '${state}' came from iterate-state.yaml, not from this invocation — the documented ` +
          `default is '${DEFAULT_RUNNER}', the observable runner. An inherited value silently selecting ` +
          `the opaque path is ace#1276; confirm it is what you want.`
        : undefined;
    return { runner: state, source: 'iterate-state', warning };
  }

  return { runner: DEFAULT_RUNNER, source: 'default' };
}
