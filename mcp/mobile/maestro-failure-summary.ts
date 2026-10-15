// The one-line reason a failed `maestro test` run gives, for error messages.
//
// Maestro ends EVERY run's stdout with a boxed advert ("Run your flows on
// Maestro Cloud") and prints its debug-output path after the failure, so the
// last N characters of the output — what registration errors used to carry —
// were the advert and nothing else (ace#2934: three lease failures in a row
// reported only the banner, hiding an "Account in use" / "No network
// connection" end state). This picks the last TOP-LEVEL `... FAILED` step and
// the last hard error line instead. Indented FAILED lines are steps nested in
// an `optional: true` probe, and ` Warning: Assertion is false` lines are those
// probes' expected misses; neither is the failure.
//
// Twin: `maestro_failure_summary` in
// infra/capabilities/android-emulator/image/cli/ace_mobile.py, which builds the
// lease's `register-part-*-failed` message. test/mcp/mobile/maestro-failure-summary.test.ts
// runs both on the same recorded output and requires identical results.

const BANNER = /^[╭│╰]/;
const HARD_ERROR = /^(Assertion is false|Element not found|Unable to |Exception|Error: |java\.|maestro\.)/;

export function maestroFailureSummary(stdout: string, stderr = '', limit = 500): string {
  const lines = `${stdout ?? ''}\n${stderr ?? ''}`
    .split('\n')
    .filter((l) => l.trim() !== '' && !BANNER.test(l.trim()));
  const failed = lines.filter((l) => !/^\s/.test(l) && l.trimEnd().endsWith('FAILED')).map((l) => l.trim());
  const errors = lines.map((l) => l.trim()).filter((l) => HARD_ERROR.test(l));
  const parts = [...failed.slice(-1), ...errors.slice(-1)];
  const out = parts.length > 0 ? parts.join(' | ') : lines.join('\n');
  return out.length > limit ? out.slice(out.length - limit) : out;
}
