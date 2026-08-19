/**
 * dimagi-internal/ace#1379 + #1380 + #1365 — three ways a DDD scene reports
 * `ok: true` while demonstrating nothing. All three surfaced on the SAME run,
 * spark-facilitator/20260813-2126, and all three are decidable from the spec
 * before a single frame is rendered.
 *
 * ── #1379: the click landed on prose ────────────────────────────────────────
 * Scene 3 (`narrow-to-who-needs-reading`) filters twenty facilitators to nine:
 *
 *     - kind: click     target: text:Needs a look
 *     - kind: wait_for  target: text:Showing
 *
 * `record_video` reported **39 actions: all ok**. The frame showed the
 * checkbox UNCHECKED and the table reading "showing 20 of 20 facilitators".
 * `getByText('Needs a look')` matched THREE nodes — a card subtitle DIV, the
 * actual LABEL control, and a reconciliation-sentence DIV — and `.first()`
 * took the DIV. Clicking a div succeeds. And `wait_for text:Showing` is
 * satisfied in BOTH states, so the gate could not fail.
 *
 * (The extra DIV had been added by an earlier craft pass reconciling three
 * attention counts — a legitimate product improvement silently broke a
 * walkthrough scene.)
 *
 * ── #1380: the scene was not idempotent ─────────────────────────────────────
 * Scene 5 (`draft-coaching-not-penalty`) clicks "Draft coaching message". The
 * first render CREATED coaching draft #5139 on the live dashboard. On the next
 * render the button read "Open draft #5139", the click failed
 * `target_not_found`, and the scene captured the un-drafted state while the
 * narration described a draft being written. Worse, the frame-fit verifier
 * replays the same actions, so RUNNING THE VERIFIER CONSUMES THE PRECONDITION
 * for the render that follows it.
 *
 * ── #1365: the artifact framed under a fixed header ─────────────────────────
 * The labs page has a ~72px fixed top bar. `scroll_to` uses Playwright's
 * `scroll_into_view_if_needed`, which lands the artifact's top edge at y < 72
 * — underneath the bar. The scene captures, the action reports ok, and seven
 * independent judges rediscovered the same defect in different words
 * (`motion_friction` 2 on 7 of 12 scenes; concept eval 2/5, fail). The control
 * case: the only two scenes scoring 4 are the two that scroll to `bottom`,
 * where no fixed header can occlude anything.
 *
 * The runtime halves of all three belong in canopy's walkthrough runner. This
 * is the ACE half — decidable from the spec `demo-narrative` authors, before
 * handing off to the DDD loop.
 */
import { describe, it, expect } from 'vitest';
import { checkSceneActions } from '../../lib/ddd-scene-actions.js';

const scene = (over: Record<string, unknown> = {}) => ({
  title: 'a scene',
  actions: [{ kind: 'wait_for', target: 'text:Showing 9 of 20' }],
  ...over,
});

describe('checkSceneActions (#1379)', () => {
  it('flags a click whose target is PROSE rather than a control', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'click', target: 'text:Needs a look' }] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('ambiguous-text-target');
    expect(r.findings[0].detail).toMatch(/control/i);
  });

  // ace#1519 — the guard's prefixes are canopy's RECORDER prefixes, which use
  // `:` and have no `=` form (`_PREFIXES` / `_PREFIX_SEPARATOR` in
  // runtime/scripts/walkthrough/_lib/targets.py). The `=` spellings the old
  // regex listed fall through parse_target to the bare-string heuristic — the
  // exact ambiguous resolution this check exists to prevent — so they must be
  // FLAGGED, not accepted. Both halves are load-bearing: without the second,
  // the regex could regress to `=` forms and this suite would stay green.
  it('accepts a click on a recorder control prefix', () => {
    for (const target of [
      'css:#filter-needs-look',
      'testid:filter-needs-look',
      'aria:Needs a look (9)',
      'role:checkbox',
      'role:checkbox:Needs a look (9)',
    ]) {
      const r = checkSceneActions([scene({ actions: [{ kind: 'click', target }] })]);
      expect(r.findings.map((f) => f.kind), target).not.toContain('ambiguous-text-target');
    }
  });

  it('flags targets the recorder does NOT parse as a control prefix', () => {
    for (const target of [
      'Needs a look (9)', // bare string — the heuristic, not a control
      'text:Needs a look (9)', // the ambiguous form being guarded against
      'css=#filter-needs-look', // `=` is not a recorder separator
      'role=checkbox[name="Needs a look (9)"]',
      'testid=filter-needs-look',
      'aria=Needs a look (9)',
      'label:Needs a look (9)', // never a recorder prefix
      'xpath=//input',
    ]) {
      const r = checkSceneActions([scene({ actions: [{ kind: 'click', target }] })]);
      expect(r.findings.map((f) => f.kind), target).toContain('ambiguous-text-target');
    }
  });

  it('remediation names only prefixes the recorder actually parses', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'click', target: 'Needs a look' }] }),
    ]);
    const detail = r.findings.find((f) => f.kind === 'ambiguous-text-target')!.detail;
    expect(detail).toMatch(/css:/);
    expect(detail).toMatch(/testid:/);
    expect(detail).not.toMatch(/css=|role=|testid=|aria=|label:/);
  });

  it('flags a wait_for gate that cannot discriminate before from after', () => {
    const r = checkSceneActions([
      scene({
        actions: [
          { kind: 'click', target: 'role:checkbox:Needs a look' },
          { kind: 'wait_for', target: 'text:Showing' },
        ],
      }),
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('non-discriminating-gate');
  });

  it('accepts a gate that names the post-state value', () => {
    const r = checkSceneActions([
      scene({
        actions: [
          { kind: 'click', target: 'role:checkbox:Needs a look' },
          { kind: 'wait_for', target: 'text:Showing 9 of 20 facilitators' },
        ],
      }),
    ]);
    expect(r.findings.map((f) => f.kind)).not.toContain('non-discriminating-gate');
  });
});

describe('checkSceneActions (#1380)', () => {
  it('flags a state-mutating click with no declared restore', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'click', target: 'role:button:Draft coaching message' }] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('mutation-without-restore');
    expect(r.findings.find((f) => f.kind === 'mutation-without-restore')!.detail).toMatch(
      /idempotent|re-run|second render/i,
    );
  });

  it('accepts the same scene once it declares a restore', () => {
    const r = checkSceneActions([
      scene({
        restore: [{ kind: 'click', target: 'role:button:Discard' }],
        actions: [{ kind: 'click', target: 'role:button:Draft coaching message' }],
      }),
    ]);
    expect(r.findings.map((f) => f.kind)).not.toContain('mutation-without-restore');
  });

  it('does not treat a read-only click as a mutation', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'click', target: 'role:tab:Payments' }] }),
    ]);
    expect(r.findings.map((f) => f.kind)).not.toContain('mutation-without-restore');
  });
});

describe('checkSceneActions (#1365)', () => {
  it('flags a scroll_to with no header offset', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'scroll_to', target: 'text:Payment rules' }] }),
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('scroll-under-fixed-header');
    expect(r.findings.find((f) => f.kind === 'scroll-under-fixed-header')!.detail).toMatch(/72/);
  });

  it('accepts scroll_to bottom — the control case that scored 4', () => {
    const r = checkSceneActions([scene({ actions: [{ kind: 'scroll_to', target: 'bottom' }] })]);
    expect(r.findings.map((f) => f.kind)).not.toContain('scroll-under-fixed-header');
  });

  it('accepts an explicit offset', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'scroll_to', target: 'text:Payment rules', offset: 96 }] }),
    ]);
    expect(r.findings.map((f) => f.kind)).not.toContain('scroll-under-fixed-header');
  });
});

describe('checkSceneActions reporting', () => {
  it('passes a fully-correct scene', () => {
    const r = checkSceneActions([
      scene({
        restore: [{ kind: 'click', target: 'role:button:Discard' }],
        actions: [
          { kind: 'scroll_to', target: 'text:Coaching', offset: 96 },
          { kind: 'click', target: 'role:button:Draft coaching message' },
          { kind: 'wait_for', target: 'text:Draft #5139 — Not sent' },
        ],
      }),
    ]);
    expect(r.ok).toBe(true);
  });

  it('names the scene each finding belongs to', () => {
    const r = checkSceneActions([
      scene({ title: 'narrow-to-who-needs-reading', actions: [{ kind: 'click', target: 'text:Needs a look' }] }),
    ]);
    expect(r.findings[0].scene).toBe('narrow-to-who-needs-reading');
  });

  it('is inert on a scene with no actions', () => {
    expect(checkSceneActions([{ title: 'static', actions: [] }]).ok).toBe(true);
  });
});
