import { describe, expect, it } from 'vitest';

import { parsePlayOutput } from '../../lib/commcare-cli-validate';

/**
 * parsePlayOutput verdict classification (dimagi-internal/ace#1025).
 *
 * The benign-EOF NPE (`Cannot invoke "String.startsWith(String)" because
 * "input" is null` at `ApplicationHost.loopSession`) fires whenever stdin
 * closes at a menu prompt — i.e. on every healthy run. The classifier must
 * recognize it wherever it sits in the stream, because `XForm Parse Warning`
 * lines routinely land on stderr AHEAD of it (any select1 whose option
 * values contain spaces — the standard ACE Learn shape, where value == label
 * for scoring), pushing the NPE off the first-line-after-fatal capture.
 *
 * Fixtures are pinned from the live capture on bednet-spot-check/20260728-2222
 * (plugin 0.13.681): same benign NPE, two different verdicts, the only
 * difference being what sits at the top of stderr.
 */

const BENIGN_NPE_STDERR = `java.lang.NullPointerException: Cannot invoke "String.startsWith(String)" because "input" is null
\tat org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:267)
\tat org.commcare.util.cli.ApplicationHost.run(ApplicationHost.java:138)
\tat org.commcare.util.cli.CliPlayCommand.handle(CliPlayCommand.java:63)`;

const HEALTHY_STDOUT = `COMMAND: m0
COMMAND: m0-f0
Form Start: Press Return to proceed
**What Connect does for you** To continue, press Return.
Press Return to Proceed
Quitting!
Unhandled Fatal Error executing CommCare app`;

const PARSE_WARNINGS = `XForm Parse Warning: select1 question <value>s [Payments come only from verified deliver units] should not contain spaces
XForm Parse Warning: select1 question <value>s [Payments arrive as soon as a form is submitted] should not contain spaces
XForm Parse Warning: select1 question <value>s [Connect pays a monthly salary] should not contain spaces
XForm Parse Warning: select1 question <value>s [Payment amounts are negotiated per visit] should not contain spaces`;

function play(stdout: string, stderr: string) {
  return parsePlayOutput({
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    timeoutMs: 30_000,
    entryPath: [0, 0],
  });
}

describe('parsePlayOutput benign-EOF classification (ace#1025)', () => {
  it('passes when the benign NPE directly follows the fatal marker (the Deliver shape)', () => {
    const res = play(HEALTHY_STDOUT, BENIGN_NPE_STDERR);
    expect(res.verdict).toBe('pass');
  });

  it('passes when XForm Parse Warnings precede the benign NPE on stderr (the Learn shape — the #1025 false BLOCKER)', () => {
    const res = play(HEALTHY_STDOUT, `${PARSE_WARNINGS}\n${BENIGN_NPE_STDERR}`);
    expect(res.verdict).toBe('pass');
    expect(res.failing_binding).toBeUndefined();
    expect(res.unresolved_xpath).toBeUndefined();
    expect(res.parser_message).toBeUndefined();
  });

  it('still fails on a real form-init defect even when the benign NPE is also present', () => {
    const crashStdout = `COMMAND: m0
COMMAND: m0-f0
Unhandled Fatal Error executing CommCare app
XPathTypeMismatchException: The problem was located in Calculate expression for /data/meta/entity_id
Error in calculation for /data/meta/entity_id`;
    const res = play(crashStdout, BENIGN_NPE_STDERR);
    expect(res.verdict).toBe('fail');
    expect(res.parser_message).toMatch(/XPathTypeMismatchException/);
  });

  it('still fails on an unknown exception class whose stack trace unwinds through loopSession (the frame must not be benign stream-wide)', () => {
    // Every crash unwinds through ApplicationHost.loopSession, so matching
    // that FRAME anywhere in the stream would reclassify real crashes as
    // benign — the hazard the classifyPlayStream doc comment names. Only the
    // NPE MESSAGE (unique to the stdin-EOF case) is safe to match stream-wide.
    const crashStdout = `COMMAND: m0
Unhandled Fatal Error executing CommCare app
java.lang.IllegalStateException: session corrupt
\tat org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:267)`;
    const res = play(crashStdout, '');
    expect(res.verdict).toBe('fail');
  });

  it('classifies the empty-casedb entity-list crash as skipped, with warnings present (ace#1088 precedence intact)', () => {
    const crashStdout = `COMMAND: m0
Unhandled Fatal Error executing CommCare app
java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0
\tat org.commcare.util.screen.EntityListSubscreen.handleInputAndUpdateHost(EntityListSubscreen.java:112)`;
    const res = play(crashStdout, PARSE_WARNINGS);
    expect(res.verdict).toBe('skipped');
    expect(res.skip_reason).toBe('empty-case-list');
  });
});
