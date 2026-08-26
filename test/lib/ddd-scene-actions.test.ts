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
 * ── #1365 → RETRACTED by ace#1660 ──────────────────────────────────────────
 * This suite used to assert a `scroll-under-fixed-header` check: flag any
 * `scroll_to` whose `offset` was under 72px, remediation "pass `offset: 96`".
 * Both halves were wrong against canopy 0.2.423 and the check is DELETED.
 *
 *   - `ScrollToAction` declares only `kind` + `target` (+ `note`/`must_succeed`/
 *     `timeout_ms` inherited), and `_ActionBase` sets
 *     `model_config = ConfigDict(extra="forbid")`. Constructed live:
 *     `ScrollToAction(kind="scroll_to", target="…", offset=96)` →
 *     `('offset',) Extra inputs are not permitted`. The remediation turned a
 *     passing spec into one canopy refuses.
 *   - The premise was stale. `recorder.py::scroll_to` chases
 *     `scroll_into_view_if_needed` with
 *     `window.scrollTo({top: y + window.scrollY - window.innerHeight / 2})`,
 *     centring the element — unreachable by a 72px bar. That is #1365's own
 *     fix, closed COMPLETED 2026-08-14.
 *
 * It cost 5 false findings on one clean spec (bednet-check-2-visit/
 * 20260825-1310). Same shape as #1519 — a checker inventing syntax for a
 * system it does not own — which is why `describe('remediation vocabulary')`
 * below now pins every key any remediation names against canopy's real schema.
 *
 * The runtime halves of all three belong in canopy's walkthrough runner. This
 * is the ACE half — decidable from the spec `demo-narrative` authors, before
 * handing off to the DDD loop.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

describe('checkSceneActions (#1660 — the retracted scroll check)', () => {
  // The regression guard. `scroll_to` on a plain element is CORRECT: the
  // recorder centres it (recorder.py::scroll_to, canopy 0.2.423), and there is
  // no `offset`-shaped field anywhere in canopy's action schema to pass anyway.
  // A spec full of bare `scroll_to`s must come back clean.
  it('does not flag a bare scroll_to — the recorder centres the element', () => {
    const r = checkSceneActions([
      scene({
        actions: [
          { kind: 'scroll_to', target: 'text:Payment rules' },
          { kind: 'scroll_to', target: 'testid:coverage-table' },
          { kind: 'scroll_to', target: 'bottom' },
        ],
      }),
    ]);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  it('emits no finding kind about scroll framing at all', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'scroll_to', target: 'text:Payment rules' }] }),
    ]);
    expect(r.findings.map((f) => f.kind)).not.toContain('scroll-under-fixed-header' as never);
  });
});

describe('checkSceneActions — the gate heuristic vs control selectors (#1660)', () => {
  // The word count is only meaningful on a target made of WORDS. Before #1660
  // only `text:` was stripped, so `testid:coverage-table` was measured as the
  // one "word" `testid:coverage-table` and flagged — while
  // `testid:coverage-table-9` passed on the stray digit, for the same gate.
  it('does not flag a control-selector gate for being short', () => {
    for (const target of [
      'testid:coverage-table',
      'css:#llo-review-status',
      'aria:Coverage',
      'role:status',
      'role:status:Complete',
    ]) {
      const r = checkSceneActions([scene({ actions: [{ kind: 'wait_for', target }] })]);
      expect(r.findings.map((f) => f.kind), target).not.toContain('non-discriminating-gate');
    }
  });

  // The heuristic still has to bite where it means something: a short `text:`
  // or bare gate is exactly the `wait_for text:Showing` case from #1379.
  it('still flags a short text or bare gate', () => {
    for (const target of ['text:Showing', 'Showing', 'text:Complete']) {
      const r = checkSceneActions([scene({ actions: [{ kind: 'wait_for', target }] })]);
      expect(r.findings.map((f) => f.kind), target).toContain('non-discriminating-gate');
    }
  });

  // Every recorder prefix is stripped before the count, so the prefix itself
  // never pads the word total into passing.
  it('strips the prefix before counting, so the prefix cannot pad the count', () => {
    const r = checkSceneActions([
      scene({ actions: [{ kind: 'wait_for', target: 'text:Showing all rows' }] }),
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('non-discriminating-gate');
    // ...and the message quotes the author's WORDS, not the prefix.
    const d = r.findings.find((f) => f.kind === 'non-discriminating-gate')!.detail;
    expect(d).toContain('"Showing all rows"');
  });
});

/**
 * ace#1660 / ace#1519 are one failure repeated: a checker invented syntax for a
 * system it does not own, and its remediation told the author to write a form
 * canopy rejects. Nothing tested the remediations, so the lesson did not carry
 * from the first to the second.
 *
 * This suite is that test. Every finding this module can emit is generated, and
 * every `identifier:` appearing in its detail must be real canopy vocabulary.
 * That rule is what makes it bite: the retracted remediation read
 * "Pass offset: 96 or scroll to bottom", and `offset` is in no vocabulary here.
 *
 * It also means detail PROSE may not use a word-then-colon shape ("NOT
 * idempotent: on the second render") — rephrase with a dash. A colon after a
 * bare identifier reads as a spec key to the author too, which is the whole
 * point.
 *
 * The vocabulary below is PINNED rather than read from disk, because canopy is
 * a plugin cache that CI does not have. It was derived by constructing canopy's
 * own pydantic models — not by reading prose — on **2026-08-26** against
 * **canopy 0.2.423** at
 * `~/.claude/plugins/cache/canopy/canopy/0.2.423/runtime`:
 *
 *   from scripts.narrative.models import *   # every *Action subclass
 *   -> ACTION_FIELDS: attr kind layer must_succeed note pattern points seconds
 *                     source target timeout_ms tool value var zoom
 *   from scripts.narrative.models import Scene
 *   -> SCENE_FIELDS:  actions concept_claim design_intent features full_page id
 *                     impressive_because narrative pace persona provenance role
 *                     show title url viewport
 *   from scripts.walkthrough._lib.targets import _PREFIXES
 *   -> PREFIXES:      css text testid aria role
 *
 * `drift` below re-derives it when canopy IS on disk, so a local run notices
 * canopy removing a field we still name. CI runs the pin alone.
 */
describe('remediation vocabulary is expressible in canopy (#1660, #1519)', () => {
  // Source: scripts/narrative/models.py, every `*Action` subclass of
  // `_ActionBase`. `_ActionBase` sets `extra="forbid"`, so naming a key OUTSIDE
  // this set in a remediation produces a spec canopy REFUSES — measured:
  // ScrollToAction(kind="scroll_to", target="x", offset=96) ->
  // "('offset',) Extra inputs are not permitted".
  const ACTION_FIELDS = [
    'attr', 'kind', 'layer', 'must_succeed', 'note', 'pattern', 'points',
    'seconds', 'source', 'target', 'timeout_ms', 'tool', 'value', 'var', 'zoom',
  ];

  // Source: scripts/narrative/models.py, `Scene`.
  const SCENE_FIELDS = [
    'actions', 'concept_claim', 'design_intent', 'features', 'full_page', 'id',
    'impressive_because', 'narrative', 'pace', 'persona', 'provenance', 'role',
    'show', 'title', 'url', 'viewport',
  ];

  // Source: scripts/walkthrough/_lib/targets.py, `_PREFIXES`.
  const PREFIXES = ['css', 'text', 'testid', 'aria', 'role'];

  // `restore` is NOT a canopy Scene field, and is listed deliberately.
  // Measured 2026-08-26: `Scene` does not set `extra="forbid"` (only
  // `_ActionBase` does), so a `restore:` block VALIDATES and is then silently
  // dropped — `hasattr(scene, "restore") == False`, absent from `model_dump()`.
  // So `mutation-without-restore` is a forward-looking ACE declaration whose
  // runtime half is upstream (see the module docstring's Scope note), not a
  // key canopy rejects. It is a weaker footing than the rest of this list and
  // should move to SCENE_FIELDS the day canopy declares it.
  const ACE_FORWARD_DECLARED = ['restore'];

  const VOCABULARY = new Set([
    ...ACTION_FIELDS, ...SCENE_FIELDS, ...PREFIXES, ...ACE_FORWARD_DECLARED,
  ]);

  // Targets here are deliberately COLON-FREE: a detail interpolates the
  // author's own target, and we are auditing what this module WROTE, not what
  // a caller passed in.
  const everyFinding = () =>
    checkSceneActions([
      { title: 's', actions: [{ kind: 'click', target: 'Needs a look' }] },
      { title: 's', actions: [{ kind: 'click', target: 'Draft coaching message' }] },
      { title: 's', actions: [{ kind: 'wait_for', target: 'Showing' }] },
      { title: 's', actions: [{ kind: 'scroll_to', target: 'Payment rules' }] },
      { title: 's', actions: [{ kind: 'goto', target: 'Dashboard' }] },
      { title: 's', actions: [{ kind: 'fill', target: 'Amount' }] },
    ]).findings;

  it('generates at least one finding of every kind it can emit', () => {
    const kinds = new Set(everyFinding().map((f) => f.kind));
    expect(kinds).toEqual(
      new Set(['ambiguous-text-target', 'mutation-without-restore', 'non-discriminating-gate']),
    );
  });

  it('names no key canopy does not accept', () => {
    for (const f of everyFinding()) {
      for (const [, key] of f.detail.matchAll(/([a-z_][a-z0-9_]*):/g)) {
        expect(
          VOCABULARY.has(key),
          `finding "${f.kind}" names "${key}:" — not a canopy action field, Scene ` +
            `field, or recorder prefix. Either it is a real key (add it to the ` +
            `pinned vocabulary with its source) or the remediation is inventing ` +
            `syntax canopy will reject (ace#1660) — or it is prose that needs a ` +
            `dash instead of a colon.\n  detail: ${f.detail}`,
        ).toBe(true);
      }
    }
  });

  it('never names offset — the retracted #1660 remediation', () => {
    for (const f of everyFinding()) expect(f.detail).not.toMatch(/\boffset\b/);
    expect(VOCABULARY.has('offset')).toBe(false);
  });

  // Drift guard, local-only: when canopy IS installed, re-derive the pin from
  // its models rather than trusting a comment. Skipped in CI, which has no
  // plugin cache.
  it('matches canopy on disk, when canopy is on disk', () => {
    const root = `${process.env.HOME}/.claude/plugins/cache/canopy/canopy`;
    if (!existsSync(root)) return; // CI — the pin above stands alone.
    const newest = readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) =>
        a.split('.').map(Number).reduce((s, n, i) => s || n - Number(b.split('.')[i]), 0),
      )
      .pop();
    const models = `${root}/${newest}/runtime/scripts/narrative/models.py`;
    if (!existsSync(models)) return;
    const src = readFileSync(models, 'utf8');

    // Every pinned ACTION field must still be DECLARED by some action model.
    // (A field canopy dropped is a remediation we may now be inventing.)
    for (const f of ACTION_FIELDS) {
      expect(new RegExp(`^\\s{4}${f}:`, 'm').test(src), `${f} in ${newest}`).toBe(true);
    }
    // And `offset` must still be absent — if canopy ever ADDS it, this test
    // fails and the retraction can be revisited on evidence.
    expect(/^\s{4}offset:/m.test(src), `offset declared in ${newest}`).toBe(false);
  });
});

describe('checkSceneActions reporting', () => {
  it('passes a fully-correct scene', () => {
    const r = checkSceneActions([
      scene({
        restore: [{ kind: 'click', target: 'role:button:Discard' }],
        actions: [
          { kind: 'scroll_to', target: 'text:Coaching' },
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
