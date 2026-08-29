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
import {
  checkSceneActions,
  checkSceneCardinality,
  datasetShapeFromRecordCounts,
  MIN_CARDINALITY,
  DETECTION_MIN_ROWS,
} from '../../lib/ddd-scene-actions.js';

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

  // ace#1670's findings go through the SAME audit. They name no canopy key at
  // all — the remediation is "change the demonstration or regenerate" — so any
  // `identifier:` appearing in one is either an invented spec key or prose that
  // wants a dash. That is exactly the lesson #1660 failed to carry forward, and
  // the only way it carries to a check written after it is to audit that one too.
  it('names no key canopy does not accept, in the cardinality findings either', () => {
    const cardinality = [
      ...checkSceneCardinality([{ title: 'filter the roster' }], { rows: 5 }).findings,
      ...checkSceneCardinality([{ title: 'the trend over time' }], undefined).findings,
      ...checkSceneCardinality([{ title: 'compare the sites' }], { groups: 2 }).findings,
      // ace#1841's finding names the axis with ROOM — `periods (6)`, written
      // with parentheses rather than `periods:` precisely so it cannot read as
      // a spec key canopy would reject. This is the assertion that keeps it so.
      ...checkSceneCardinality([{ title: 'flag the outliers' }], { rows: 7, periods: 6 }).findings,
    ];
    expect(cardinality.length).toBeGreaterThan(0);
    for (const f of cardinality) {
      for (const [, key] of f.detail.matchAll(/([a-z_][a-z0-9_]*):/g)) {
        expect(
          VOCABULARY.has(key),
          `finding "${f.kind}" names "${key}:" — not canopy vocabulary (ace#1660).\n  detail: ${f.detail}`,
        ).toBe(true);
      }
    }
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

/**
 * ace#1670 — the demonstration was impossible on the data.
 *
 * bednet-check-2-visit/20260825-1310 authored a filter scene over a
 * **five-worker** cohort. Nothing checked the scene's premise against the
 * dataset's shape: `realized.json` is a flat URL map by design and
 * `products.synthetic.source` carried no counts, so `demo-narrative` could not
 * tell a filter over 5 rows from one over 500. `checkSceneActions` passed it
 * (the action is well-formed), `scripts.ddd.validate` passed it (the spec is
 * valid), and the concept judge caught it after a full render — four
 * iterations in, ending the loop `stopped_not_converged` at concept 3.0.
 *
 * The generator's own response had the answer before the first frame:
 * `record_counts` = `{opportunity: 1, user_visits: 276, user_data: 5,
 * completed_works: 0, completed_module: 0}`.
 */
describe('checkSceneCardinality (#1670)', () => {
  // The actual failing shape, verbatim from the run's
  // synthetic_generate_from_manifest response (quoted in the issue).
  const BEDNET_RECORD_COUNTS = {
    opportunity: 1,
    user_visits: 276,
    user_data: 5,
    completed_works: 0,
    completed_module: 0,
  };

  // A filter demonstration in the form the run authored it: a control-prefixed
  // click (so `checkSceneActions` is clean) gated on a post-state count (so the
  // gate check is clean too). Every existing gate reports green on this scene —
  // only its PREMISE is wrong.
  const filterScene = {
    title: 'narrow the roster to who needs a look',
    actions: [
      { kind: 'click', target: 'testid:filter-needs-attention' },
      { kind: 'wait_for', target: 'text:Showing 2 of 5 workers' },
    ],
  };

  it('is invisible to the checks that already exist', () => {
    expect(checkSceneActions([filterScene]).ok).toBe(true);
  });

  it('flags the bednet filter demo over the 5-worker cohort', () => {
    const shape = datasetShapeFromRecordCounts(BEDNET_RECORD_COUNTS);
    expect(shape.rows).toBe(5);

    const r = checkSceneCardinality([filterScene], shape);
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.kind === 'insufficient-cardinality')!;
    expect(f, JSON.stringify(r.findings)).toBeTruthy();
    expect(f.scene).toBe('narrow the roster to who needs a look');
    // It must say what it has, what it needs, and which axis.
    expect(f.detail).toContain('5');
    expect(f.detail).toContain(String(MIN_CARDINALITY.rows));
    expect(f.detail).toMatch(/rows/);
    // ...and both actionable branches from the issue.
    expect(f.detail, 'the change-the-demonstration branch').toMatch(/pick a demonstration/i);
    expect(f.detail, 'the regenerate branch').toMatch(/regenerate with a larger cohort/i);
  });

  it('passes the SAME scene over a plausible large cohort', () => {
    const r = checkSceneCardinality(
      [filterScene],
      datasetShapeFromRecordCounts({ ...BEDNET_RECORD_COUNTS, user_data: 240 }),
    );
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  it('reads only what record_counts can answer, and leaves the rest unknown', () => {
    // `user_data` is the one entity population in the response. `user_visits`
    // is the fact table those rows aggregate; `completed_*` are counters;
    // `opportunity` is the container. None of them is a period or a group, and
    // inventing one from 276 visits is precisely the mistake this guards.
    const shape = datasetShapeFromRecordCounts(BEDNET_RECORD_COUNTS);
    expect(shape).toEqual({ rows: 5 });
    expect(datasetShapeFromRecordCounts(undefined)).toEqual({});
  });

  it('lets the caller override rows for a surface that enumerates something else', () => {
    // The dashboard that lists 276 visit rows is not the dashboard that lists
    // 5 workers, and only the skill that authored it knows which.
    const shape = datasetShapeFromRecordCounts(BEDNET_RECORD_COUNTS, { rows: 276 });
    expect(shape.rows).toBe(276);
    expect(checkSceneCardinality([filterScene], shape).ok).toBe(true);
  });

  // The issue's explicit second axis: "A trend demo over 276 visits but 1 week
  // of dates is the same defect with a different axis." A dataset can be large
  // on the axis the scene does not need.
  it('flags a trend on PERIODS even when the row count is generous', () => {
    const trendScene = {
      title: 'coverage trend over time',
      actions: [{ kind: 'wait_for', target: 'testid:coverage-trend' }],
    };
    const r = checkSceneCardinality([trendScene], { rows: 276, periods: 1, groups: 4 });
    const f = r.findings.find((x) => x.kind === 'insufficient-cardinality')!;
    expect(f, JSON.stringify(r.findings)).toBeTruthy();
    expect(f.detail).toMatch(/periods/);
    expect(f.detail).toContain(String(MIN_CARDINALITY.periods));
    // And the generous row count neither excused it nor produced a finding of
    // its own. (The detail DOES now name `rows` — as the axis with room, which
    // is the actionable half of the remediation, ace#1841 — so the assertion is
    // on the CLAIM, not on the substring.)
    expect(r.findings).toHaveLength(1);
    expect(f.detail).not.toMatch(/needs at least \d+ rows/);
  });

  it('passes a trend once the series is long enough to show a turn', () => {
    const trendScene = {
      title: 'coverage trend over time',
      actions: [{ kind: 'wait_for', target: 'testid:coverage-trend' }],
    };
    expect(checkSceneCardinality([trendScene], { rows: 276, periods: 8, groups: 4 }).ok).toBe(true);
  });

  it('flags a comparison of two groups, and passes three', () => {
    const compareScene = {
      title: 'compare the three sites',
      actions: [{ kind: 'click', target: 'testid:site-breakdown' }],
    };
    expect(checkSceneCardinality([compareScene], { rows: 40, periods: 8, groups: 2 }).ok).toBe(
      false,
    );
    expect(
      checkSceneCardinality([compareScene], { rows: 40, periods: 8, groups: 3 }).ok,
      JSON.stringify(checkSceneCardinality([compareScene], { rows: 40, periods: 8, groups: 3 })),
    ).toBe(true);
  });

  // Silence on an unknown axis IS the ace#1670 failure — the skill had no
  // cardinality input at all and authored the scene anyway.
  it('flags a demonstration whose axis the handoff does not carry', () => {
    const r = checkSceneCardinality([filterScene], undefined);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('unknown-cardinality');
    expect(r.findings[0].detail).toMatch(/record_counts/);
  });

  it('flags only the missing axis when the others are known', () => {
    const trendScene = {
      title: 'the recovery trajectory week over week',
      actions: [{ kind: 'wait_for', target: 'testid:muac-trajectory' }],
    };
    const r = checkSceneCardinality([trendScene], { rows: 40 });
    expect(r.findings.map((f) => f.kind)).toEqual(['unknown-cardinality']);
    expect(r.findings[0].detail).toMatch(/periods/);
  });

  it('is inert on a scene that demonstrates none of the three', () => {
    const r = checkSceneCardinality(
      [
        {
          title: 'the programme at a glance',
          actions: [
            { kind: 'scroll_to', target: 'text:Coverage' },
            { kind: 'wait_for', target: 'text:Showing 9 of 20 facilitators' },
          ],
        },
      ],
      { rows: 1, periods: 1, groups: 1 },
    );
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  // The vocabulary is deliberately tight, and these are the words left OUT on
  // purpose. `top` is a `scroll` target and `weekly` is half the labs template
  // names — either in the pattern would fire this check on scenes that
  // demonstrate nothing of the kind, and a checker that cries wolf is the
  // ace#1660 failure repeated. This pins the omissions so a later "let's widen
  // the regex" pass has to argue with a test.
  it('does not read ordinary spec syntax or template names as demonstrations', () => {
    for (const s of [
      { title: 'the payment rules', actions: [{ kind: 'scroll_to', target: 'top' }] },
      { title: 'the LLO weekly review', actions: [{ kind: 'wait_for', target: 'testid:llo-weekly-review' }] },
      { title: 'open the dashboard', actions: [{ kind: 'goto', target: '${llo_review_par_url}' }] },
      { title: 'a scene', actions: [{ kind: 'wait_for', target: 'text:Showing 9 of 20' }] },
    ]) {
      const r = checkSceneCardinality([s], { rows: 1, periods: 1, groups: 1 });
      expect(r.ok, `${s.title} -> ${JSON.stringify(r.findings)}`).toBe(true);
    }
  });

  it('reports the same shape as checkSceneActions', () => {
    const r = checkSceneCardinality([filterScene], { rows: 5 });
    expect(Object.keys(r).sort()).toEqual(['findings', 'ok']);
    expect(Object.keys(r.findings[0]).sort()).toEqual(['detail', 'kind', 'scene']);
  });

  it('is inert on an empty scene list', () => {
    expect(checkSceneCardinality([], undefined).ok).toBe(true);
  });
});

/* ─────────────────── #1841 — detection is a fourth verb ─────────────────── */

describe('checkSceneCardinality (#1841 — detection)', () => {
  // VERBATIM from hh-poverty-targeting/20260828-0702's spec,
  // 7-synthetic/hh-poverty-targeting-answer-quality.yaml (Drive
  // 1ZDKLQFHBGX9s3Xp9FmjyHzlRPecwwv50lEbUDuZ08TA), the run that ended
  // stopped_not_converged at concept 2.0/5 over four iterations.
  //
  // Note where the detection vocabulary IS and IS NOT. Neither title contains
  // one; the words sit in `show`, `concept_claim` and `features[]`. That is why
  // the fix is a wider text surface as well as a new verb — a detection pattern
  // over title+targets alone would have matched ZERO of this spec's 8 scenes.
  const detectionScene = {
    title: 'One worker outside the expected range',
    show:
      "The per-worker table, where the non-payable share column marks the one worker sitting " +
      "outside the design's 20-35% band and every other worker sits inside it.",
    concept_claim:
      'An expected range prompts a supervisor to look without rewarding a worker who ' +
      'under-records a refusal.',
    features: [
      {
        description:
          "A per-worker non-payable share column computed as refused plus vacant plus " +
          "no-respondent over that worker's own total doors, rendered against the design's " +
          'stated 20-35% expected range, marking a worker outside it as outside the expected ' +
          'range rather than as underperforming, with no completion-rate threshold anywhere ' +
          'on the page.',
        verify:
          'A worker whose non-payable share falls outside 0.20 to 0.35 renders the ' +
          'outside-the-expected-range marker and its share value in the warning colour, and no ' +
          'row anywhere on the page renders a review or underperforming marker derived from a ' +
          'completion rate.',
      },
    ],
    actions: [{ kind: 'scroll_to', target: 'css:table' }],
  };

  // Same run, the scene whose whole point is that the operations page shows
  // NOTHING — no detection, no filter, no trend. It is the discrimination test:
  // a rule that fires here fires on every scene in the spec.
  const nonDemonstrationScene = {
    title: 'Every column here is a count or an average',
    show:
      'The full width of the operations table — outcome counts, mean PPI score, mean poverty ' +
      'likelihood, mean household size, mean fix accuracy — with the two workers this ' +
      'narrative is about sitting unremarkably in the middle of it.',
    concept_claim:
      'A completed share and a mean score cannot separate a worker who asked the questions ' +
      'from one who did not.',
    features: [
      {
        description:
          'One row per field worker carrying the completed share with an inline bar, the three ' +
          'non-payable outcome counts, the non-payable share, mean PPI score out of the 102 ' +
          "attainable, mean poverty likelihood as a percentage from the instrument's own " +
          'lookup table, and mean fix accuracy in metres.',
        verify:
          "Every worker row renders a numeric mean PPI score and a completed share equal to " +
          "that row's own completed count over its own doors count.",
      },
    ],
    actions: [{ kind: 'scroll', target: undefined }],
  };

  // The run's realized shape: six funded workers plus one, over a six-week window.
  const HH_SHAPE = { rows: 7, periods: 6 };

  it('is invisible to the checks that already exist', () => {
    expect(checkSceneActions([detectionScene]).ok).toBe(true);
  });

  // POSITIVE CONTROL — the whole point of the issue.
  it('fires on the hh-poverty-targeting detection demo over 7 workers', () => {
    const r = checkSceneCardinality([detectionScene], HH_SHAPE);
    expect(r.ok, JSON.stringify(r.findings)).toBe(false);

    const f = r.findings.find((x) => x.kind === 'insufficient-cardinality')!;
    expect(f, JSON.stringify(r.findings)).toBeTruthy();
    expect(f.scene).toBe('One worker outside the expected range');
    expect(f.detail).toContain('detection');
    expect(f.detail).toContain(String(DETECTION_MIN_ROWS));
    expect(f.detail).toContain('7');
    // It must name the ALTERNATIVE AXIS, because that is the action the author
    // takes: on this dataset the axis with room is six weeks, not seven workers.
    expect(f.detail, 'names the axis with room').toMatch(/periods \(6\)/);
  });

  // ...and it would NOT have fired before the text surface was widened: the
  // title carries no detection word at all.
  it('finds the verb in the prose, not the title', () => {
    const titleOnly = { title: detectionScene.title, actions: detectionScene.actions };
    expect(checkSceneCardinality([titleOnly], HH_SHAPE).ok).toBe(true);
  });

  // NEGATIVE CONTROL — a gate that fires on every detection scene is worse than
  // no gate (ace#1026). At a cohort where flagging genuinely earns its keep,
  // the SAME scene must stay clean.
  it('stays clean on the same detection demo over a cohort that needs the flag', () => {
    const r = checkSceneCardinality([detectionScene], { rows: 60, periods: 6, groups: 4 });
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  it('is clean exactly at the floor and flags one row below it', () => {
    const at = { rows: DETECTION_MIN_ROWS, periods: 6 };
    const below = { rows: DETECTION_MIN_ROWS - 1, periods: 6 };
    expect(checkSceneCardinality([detectionScene], at).ok).toBe(true);
    expect(checkSceneCardinality([detectionScene], below).ok).toBe(false);
  });

  // The two floors are independent, on the same axis. A 12-row cohort is enough
  // to filter and not enough to detect — which is the whole reason detection
  // needed its own number rather than reusing MIN_CARDINALITY.rows.
  it('keeps detection strictly above the filter floor on the same axis', () => {
    expect(DETECTION_MIN_ROWS).toBeGreaterThan(MIN_CARDINALITY.rows);

    const twelve = { rows: MIN_CARDINALITY.rows, periods: 6, groups: 4 };
    const filterScene12 = { title: 'narrow the roster to who needs a look' };
    expect(
      checkSceneCardinality([filterScene12], twelve).ok,
      'the filter floor must not have moved',
    ).toBe(true);
    expect(checkSceneCardinality([detectionScene], twelve).ok).toBe(false);
  });

  // Discrimination: the scene from the same spec that demonstrates nothing must
  // stay clean at the same cohort size the detection scenes fail at.
  it('is inert on the same run’s non-demonstration scene', () => {
    const r = checkSceneCardinality([nonDemonstrationScene], HH_SHAPE);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  // Widening the surface must not have turned prose into demonstrations for the
  // ORIGINAL three verbs. Measured on the failing spec: filter / trend /
  // comparison vocabulary occurs ZERO times in all 14.5 KB of it.
  it('does not read ordinary scene prose as a filter, trend, or comparison', () => {
    for (const s of [detectionScene, nonDemonstrationScene]) {
      const r = checkSceneCardinality([s], { rows: 60, periods: 1, groups: 1 });
      expect(r.ok, `${s.title} -> ${JSON.stringify(r.findings)}`).toBe(true);
    }
  });

  // The tight-vocabulary rule the module states for the other three verbs
  // applies here too: a word that is ordinary prose or dashboard chrome must
  // not fire the check. `mark` bare is a given name; `missing` is chrome.
  it('does not fire on words left out of the detection vocabulary on purpose', () => {
    for (const s of [
      { title: 'a scene', show: 'Mark opens the roster and reads the week.' },
      { title: 'a scene', show: 'Rows with missing data render an em dash.' },
      { title: 'a scene', show: 'The benchmark column sits beside the mean.', concept_claim: '' },
      { title: 'a scene', concept_claim: 'A landmark week for the cohort.' },
    ]) {
      const r = checkSceneCardinality([s], { rows: 7, periods: 6, groups: 4 });
      expect(r.ok, `${s.show ?? s.concept_claim} -> ${JSON.stringify(r.findings)}`).toBe(true);
    }
  });

  it('says so when no other axis has room either', () => {
    const r = checkSceneCardinality([detectionScene], { rows: 7, periods: 1, groups: 1 });
    const f = r.findings.find((x) => x.kind === 'insufficient-cardinality')!;
    expect(f.detail).toMatch(/No other axis in the handoff has room/);
  });
});
