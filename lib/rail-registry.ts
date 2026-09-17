/**
 * Provenance for ACE's repo-policing rails — the pure analysis behind
 * `test/skills/rail-registry.test.ts`.
 *
 * ## The failure class
 *
 * ACE's answer to every incident is "add a rail". That instinct is correct and
 * `CLAUDE.md` states it as policy — *class-level preventers > instance-level
 * fixes*. What it has never had is a counterweight: no rail has to say where
 * its defect was observed, none expires, and there is no path by which one
 * ever leaves. A ratchet that only turns one way is the right shape for a
 * single invariant and the wrong shape for a population of them.
 *
 * Measured on `main`, 2026-09-16 — tests under `test/skills/` and `test/docs/`
 * that read the repo's own sources and assert something about them:
 *
 *   | first added | rails |
 *   |-------------|-------|
 *   | 2026-04     | 1     |
 *   | 2026-05     | 3     |
 *   | 2026-07     | 3     |
 *   | 2026-08     | 41    |
 *   | 2026-09     | 44    |
 *
 * The apparatus roughly quadrupled in two months. Each rail is individually
 * defensible; the population is not obviously so, and nobody can tell, because
 * the two questions a prune review needs — *what did this prevent* and *has it
 * ever fired* — have no answer recorded anywhere.
 *
 * ## What this module does, and deliberately does not
 *
 * It answers the first question and nothing else. Every rail declares where
 * its defect was OBSERVED: an issue at minimum, a run id and artifact where
 * one exists. That is the same discipline
 * `test/skills/predictive-guard-citation.test.ts` already imposes on a skill
 * that predicts another system's behaviour, turned on the rails themselves.
 *
 * It does NOT record whether a rail has ever fired. Firing telemetry needs CI
 * integration — a record of which assertion blocked which push — and inventing
 * a local approximation of it would be a guess wearing a number. This registry
 * is the hook that work hangs from later; `provenance + firing history` is what
 * makes a prune review decidable, and this is half of it.
 *
 * ## `unknown` is a finding, not a gap to paper over
 *
 * Five rails have no discoverable provenance. They are recorded as `unknown`
 * with a note saying what was searched, because an honest `unknown` is the
 * INPUT to a prune review — a rail nobody can attach to an incident is the
 * first candidate for deletion — whereas a plausible-looking citation
 * manufactured to fill the field destroys exactly the signal the registry
 * exists to carry. `CLAUDE.md § Conventions` makes the same point about issue
 * filings: a fabricated citation is worse than none.
 *
 * *Enforced:* `test/skills/rail-registry.test.ts` — the registry must match
 * the filesystem (so a new rail cannot be added without declaring provenance),
 * every declared citation must actually appear in the rail it is attached to
 * and every declared measurement must be quoted verbatim from it (so neither
 * field can be filled with fiction), and both `unknown` and `measurement` are
 * ratcheted downward so they cannot become the escape hatch.
 */

/** Where the defect a rail prevents was actually observed. */
export interface RailProvenance {
  /**
   * Tracker references, `repo#n` (bare `#n` means this repo). Normalised by
   * `citationsIn`: `jjackson/ace#818` and `dimagi-internal/ace#818` are both
   * `ace#818`, because the repo moved orgs and both spellings are in the tree.
   */
  issues: readonly string[];
  /** ACE run id where it was observed, `<opp>/<YYYYMMDD-HHMM>`. */
  observed?: string;
  /**
   * For a rail commissioned from a MEASURED POPULATION rather than from one
   * defect — "92 rails, added 1 / 3 / 3 / 41 / 44 per month". That is real
   * provenance and the registry has to be able to say it, or a rail of this
   * shape is forced to choose between an `unknown` it does not owe and a
   * borrowed issue number it does not deserve.
   *
   * The text must appear VERBATIM in the rail's own source, so the reader can
   * find the measurement and re-run it. Ratcheted like `unknown`, because an
   * unfalsifiable free-text field is otherwise the obvious escape hatch.
   */
  measurement?: string;
  /**
   * Set when provenance is NOT discoverable. The string says what was
   * searched and came back empty — never a guess at what the rail was for.
   * An entry may not carry both `unknown` and a non-empty `issues`.
   */
  unknown?: string;
  /** Anything a reader needs to reconcile the entry with the file. */
  note?: string;
}

/** Directories whose tests are in scope. */
export const RAIL_DIRS: readonly string[] = ['test/skills', 'test/docs'];

/** A test that reads files off disk at all. */
const DISK_READ = /\b(?:readFileSync|readdirSync|globSync)\s*\(/;

/**
 * A path literal naming one of the repo's SOURCE trees.
 *
 * This is what separates a repo-policing rail from an ordinary unit test that
 * happens to load a fixture. `skills/<name>/checks.test.ts` reads
 * `join(__dirname, 'fixtures')` and tests a function; a rail reads
 * `skills/inbox-triage/SKILL.md` and asserts something about the repo. Both
 * call `readFileSync`, and only the second one is a rail — so the rule is the
 * SHAPE OF THE PATH, not the presence of a read.
 *
 * Measured against the tree as it stood before this module: 92 of the 107
 * tests in `RAIL_DIRS` are rails, and the 15 excluded are exactly the
 * per-skill `checks.test.ts` suites plus four script tests. Adding or removing
 * `test` from the alternation changes nothing either way, which is the
 * evidence that the rule discriminates on the shape of the path rather than on
 * the accident of which directory a fixture happens to live in.
 */
const SOURCE_PATH =
  /['"`](?:\.\.\/)*(?:skills|lib|agents|commands|docs|playbook|templates|mcp|scripts|hooks|config|bin|migrations|test|\.claude-plugin)(?:\/[^'"`\n]*)?['"`]/;

/** Does this test source police the repo rather than test a unit? */
export function isRepoPolicingRail(source: string): boolean {
  return DISK_READ.test(source) && SOURCE_PATH.test(source);
}

const ISSUE = /(?:([A-Za-z][\w.-]*(?:\/[\w.-]+)?)(?=#))?#(\d{3,5})\b/g;
const RUN = /([a-z][a-z0-9-]{2,40})\/(20\d{6}-\d{4})/g;

/**
 * Normalise a tracker reference to `<repo>#<n>`.
 *
 * ACE's own issues appear as `#1238`, `ace#1238`, `jjackson/ace#1238` and
 * `dimagi-internal/ace#1238` — four spellings of one thing, because the repo
 * changed orgs mid-history. Upstream references keep their repo
 * (`commcare-nova#545`), because collapsing those to a bare number would make
 * a Nova issue indistinguishable from an ACE one in a prune review.
 */
export function normaliseIssue(owner: string | undefined, n: string): string {
  if (!owner) return `ace#${n}`;
  const repo = owner.includes('/') ? owner.split('/')[1] : owner;
  return `${repo}#${n}`;
}

/** Every tracker reference and run id in a source file. */
export function citationsIn(source: string): { issues: string[]; runs: string[] } {
  return {
    issues: [...new Set([...source.matchAll(ISSUE)].map((m) => normaliseIssue(m[1], m[2])))],
    runs: [...new Set([...source.matchAll(RUN)].map((m) => `${m[1]}/${m[2]}`))],
  };
}

/**
 * Every repo-policing rail, with where its defect was observed.
 *
 * Bootstrapped 2026-09-16 by scanning each rail's own header, then hand-checked
 * for the ten the header did not cite — five of which turned out to carry
 * provenance below their first `describe` (these files hold several sections,
 * each with its own header) and five of which carry none anywhere.
 *
 * A new rail adds a line here. That is the point: the cost of adding a rail
 * now includes saying what it is for.
 */
export const RAILS: Readonly<Record<string, RailProvenance>> = {
  'test/docs/ace-web-primary-surface.test.ts': { issues: ['ace#2378'] },
  'test/docs/allowlist-named-authorization.test.ts': { issues: [], unknown: 'no issue, run id or reproducer anywhere in the file; the header argues the invariant from first principles' },
  'test/docs/orchestrator-inline-handoff-fallback.test.ts': { issues: ['ace#2221', 'ace#1103'], observed: 'spark-facilitator/20260907-1120' },
  'test/docs/tracker-link-not-a-counterpart-deliverable.test.ts': { issues: ['ace#2386', 'ace#2378'] },
  'test/docs/upstream-absence-claims.test.ts': { issues: ['ace#1833', 'connect-labs#1331', 'commcare-nova#545', 'ace#1886', 'ace#1621'] },
  'test/skills/agent-turn-review-not-dispatched.test.ts': { issues: [], unknown: 'no issue, run id or reproducer anywhere in the file' },
  'test/skills/aging-parked-item-not-reflagged.test.ts': { issues: ['ace#818'], note: 'cited at the negative control, not in the file header' },
  'test/skills/app-deploy-contracts.test.ts': { issues: ['ace#1331', 'ace#1295', 'ace#1327'], observed: 'bednet-check-2-visit/20260814-0856', note: 'multi-section file; provenance sits above the second describe' },
  'test/skills/app-language-layer.test.ts': { issues: ['ace#1391', 'ace#968', 'ace#1463'] },
  'test/skills/app-release-contract.test.ts': { issues: ['ace#1439', 'ace#1010', 'ace#1636', 'ace#1567'], observed: 'bednet-check-2-visit/20260814-2019' },
  'test/skills/app-release-drift-check.test.ts': { issues: ['ace#1643'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/app-release-step-integrity.test.ts': { issues: ['ace#1490'] },
  'test/skills/archetype-enum-drift.test.ts': { issues: ['ace#1486', 'ace#2312'] },
  'test/skills/build-memo-contract.test.ts': { issues: ['ace#2371', 'ace#892', 'ace#2174'], observed: 'poverty-graduation/20260905-1345' },
  'test/skills/build-phase-decision-rows.test.ts': { issues: ['ace#2384', 'ace#399'], observed: 'poverty-graduation/20260905-1345' },
  'test/skills/claims-authoring.test.ts': { issues: [], unknown: 'no issue, run id or reproducer anywhere in the file; states a write-side convention and names no incident' },
  'test/skills/component-brief-case-list-scoping.test.ts': { issues: ['ace#1652', 'ace#1195', 'ace#977', 'ace#1281'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/connect-app-release-label-claims.test.ts': { issues: ['ace#2185'] },
  'test/skills/connect-terminology.test.ts': { issues: [], unknown: 'no issue or run id in the file; CLAUDE.md cites this rail as the enforcement of the terminology rule but names no incident either' },
  'test/skills/credential-hygiene-vs-widget-url.test.ts': { issues: ['ace#1680', 'ace#1021'], observed: 'spark-facilitator/20260820-0817' },
  'test/skills/date-field-two-sided-bounds.test.ts': { issues: ['ace#1788'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/decisions-example-currency.test.ts': { issues: ['ace#1485'] },
  'test/skills/decisions-vocabulary-drift.test.ts': { issues: ['ace#1994'], observed: 'poverty-graduation/20260905-0924' },
  'test/skills/deliver-gate-duration-floor.test.ts': { issues: ['ace#1667', 'ace#1066'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/deliver-l0-loop-integrity.test.ts': { issues: ['ace#1489'] },
  'test/skills/demo-narrative-claim-shapes.test.ts': { issues: ['ace#1395'] },
  'test/skills/deploy-summary-owns-no-release-state.test.ts': { issues: ['ace#1636', 'ace#1010', 'ace#1439', 'ace#1567'], observed: 'bednet-check-2-visit/20260820-0832' },
  'test/skills/entity-state-taxonomy-component.test.ts': { issues: ['ace#1564'] },
  'test/skills/eval-calibration-anchors.test.ts': { issues: ['ace#1212'] },
  'test/skills/eval-gate-artifact-ownership.test.ts': { issues: ['ace#1010', 'ace#1439', 'ace#1567'] },
  'test/skills/eval-rubric-dimension-integrity.test.ts': { issues: ['ace#1559'] },
  'test/skills/eval-verdict-filename-prose.test.ts': { issues: ['ace#1815', 'ace#712', 'ace#619', 'ace#786'] },
  'test/skills/gate-brief-removal-complete.test.ts': { issues: ['ace#1805', 'ace#1880', 'ace#1884'] },
  'test/skills/hq-settings-backstop.test.ts': { issues: ['ace#1009', 'ace#867', 'ace#971', 'ace#994'] },
  'test/skills/idea-to-pdd-input-doc-comments.test.ts': { issues: ['ace#2372'] },
  'test/skills/idea-to-pdd-qa-longitudinal-taxonomy.test.ts': { issues: ['ace#1783', 'ace#1564'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/idea-to-pdd-qa/required-sections-producible.test.ts': { issues: ['ace#1770', 'ace#1286'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/idea-to-pdd/decisions-fixture.test.ts': { issues: ['ace#144'] },
  'test/skills/in-app-control-existence-claims.test.ts': { issues: ['ace#2106', 'ace#1884', 'ace#1026'], observed: 'bednet-check-2-visit/20260902-1555' },
  'test/skills/inbox-triage-aging-reachable.test.ts': { issues: ['ace#818', 'ace#1931'] },
  'test/skills/instrument-source-resolution.test.ts': { issues: ['ace#1648'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/journey-count-consistency.test.ts': { issues: ['ace#2274', 'ace#1545'], observed: 'malaria-itn-app/20260517-1829' },
  'test/skills/journeys-gps-observability.test.ts': { issues: ['ace#1619', 'ace#1006', 'ace#1213'] },
  'test/skills/kb-contacts-present.test.ts': { issues: ['ace#1665', 'ace#1018'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/kb-instrument-contamination.test.ts': { issues: ['ace#1018'] },
  'test/skills/large-artifact-localfilepath.test.ts': { issues: ['ace#1918', 'ace#1780', 'ace#1907', 'ace#2055'] },
  'test/skills/learn-suite-reentry-guarded.test.ts': { issues: ['ace#1633', 'ace#1071', 'ace#897'], observed: 'bednet-check-2-visit/20260825-1310' },
  'test/skills/media-form-tile-revert-guard.test.ts': { issues: ['ace#2413', 'commcare-nova#625'], observed: 'poverty-graduation/20260915-1518' },
  'test/skills/negative-control-ratchet.test.ts': { issues: ['ace#1693', 'ace#1695', 'ace#1701', 'ace#1679', 'ace#1026', 'ace#1688', 'ace#1689', 'ace#2422', 'ace#2396', 'ace#2398', 'ace#1946', 'ace#2429', 'ace#2426'], observed: 'spark-facilitator/20260820-0817' },
  'test/skills/no-per-location-cap.test.ts': { issues: [], observed: 'turmeric-market-study/20260916-1650' },
  'test/skills/nova-contracts.test.ts': { issues: [], unknown: 'no issue or run id in the file; predates the convention (added 2026-04, the oldest rail here)' },
  'test/skills/nova-uuid-addressing.test.ts': { issues: ['ace#1132', 'ace#1151'] },
  'test/skills/ocs-deep-suite-contract.test.ts': { issues: ['ace#1956'] },
  'test/skills/ocs-knowledge-refresh.test.ts': { issues: ['ace#2107'], note: 'cited inline at the assertion it justifies' },
  'test/skills/ocs-knowledge-sources-producer.test.ts': { issues: ['ace-web#740', 'ace#1715', 'ace#1755'], observed: 'spark-facilitator/20260820-0817' },
  'test/skills/ocs-public-chat-gate-docs.test.ts': { issues: ['ace#1812', 'ace#4275', 'ace#4230'] },
  'test/skills/ocs-public-url-producer.test.ts': { issues: ['ace#1839', 'ace#1021'], observed: 'hh-poverty-targeting/20260828-0702' },
  'test/skills/ocs-publication-gate.test.ts': { issues: ['ace#1905', 'ace#891', 'ace#1828', 'ace#1895'] },
  'test/skills/ocs-upload-strips-data-uris.test.ts': { issues: ['ace#1827'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/onboarding-email-word-band.test.ts': { issues: ['ace#1673', 'ace#1654'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/payability-key-names-entity-name.test.ts': { issues: ['ace#1958', 'ace#1434'], observed: 'bednet-check-2-visit/20260902-1555' },
  'test/skills/pdd-must-not-assert-mechanisms.test.ts': { issues: ['ace#1213'] },
  'test/skills/pdd-retired-premise-bidirectional.test.ts': { issues: ['ace#1924', 'ace#1213', 'commcare-nova#458'] },
  'test/skills/pdd-to-work-order-qa/checks.test.ts': { issues: ['ace#1609'], observed: 'malaria-itn-app/20260521-1025' },
  'test/skills/per-run-test-user-switch.test.ts': { issues: ['ace#1289'] },
  'test/skills/post-build-components-not-briefed.test.ts': { issues: ['ace#1632'], observed: 'bednet-check-2-visit/20260825-1310' },
  'test/skills/predictive-guard-citation.test.ts': { issues: ['ace#1238'], observed: 'turmeric-market-study/20260914-1742' },
  'test/skills/qa-check-count-drift.test.ts': { issues: ['ace#2272', 'ace#1420', 'ace#1783'], observed: 'bednet-check-2-visit/20260908-1544' },
  'test/skills/qa-export-format.test.ts': { issues: ['ace#1609', 'ace#1617', 'ace#2169', 'ace#2178', 'ace#952'] },
  'test/skills/queue-pull-sender-provenance.test.ts': { issues: ['ace#2399'] },
  'test/skills/rail-registry.test.ts': {
    issues: [],
    measurement: '92 rails, added 1 / 3 / 3 / 41 / 44 per month from April to September',
    note:
      'commissioned from the population measurement quoted above during the 2026-09-16 ' +
      'guard-lifecycle review, not from a single defect — this rail IS the registry',
  },
  'test/skills/remedy-verification-contract.test.ts': { issues: ['ace#1900', 'ace#2004', 'ace#2027', 'ace#1768', 'ace#1766', 'ace#1466', 'ace#1468'] },
  'test/skills/retired-widget-handoff-path.test.ts': { issues: ['ace#2300'], observed: 'bednet-check-2-visit/20260908-1544' },
  'test/skills/runtime-resolution.test.ts': { issues: ['ace#395'] },
  'test/skills/selector-map-heal.test.ts': { issues: ['ace#1256', 'ace#1571', 'ace#811', 'ace#893'], note: 'multi-section file; provenance sits above the second describe' },
  'test/skills/shipping-version-race.test.ts': { issues: ['ace#1593', 'ace#1595', 'ace#1596', 'ace#1584', 'ace#1597', 'ace#1598', 'ace#1588', 'ace#1601'] },
  'test/skills/skill-atom-field-claims.test.ts': { issues: ['ace#1550'] },
  'test/skills/solicitation-end-date-addend.test.ts': { issues: ['ace#1858'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/solicitation-zero-responses-doctrine.test.ts': { issues: ['ace#2171'] },
  'test/skills/starter-module-removal.test.ts': { issues: ['ace#1787'], observed: 'bednet-check-2-visit/20260828-0629' },
  'test/skills/threshold-coherence-conditioned-radius.test.ts': { issues: ['ace#2373', 'ace#984'] },
  'test/skills/training-artifact-write-contracts.test.ts': { issues: ['ace#866', 'ace#1304'] },
  'test/skills/training-deck-module-numbering.test.ts': { issues: ['ace#1829'] },
  'test/skills/training-faq-consent-coverage.test.ts': { issues: ['ace#1687'], observed: 'hh-poverty-targeting/20260824-1404' },
  'test/skills/turn-self-check-is-a-checkpoint.test.ts': { issues: ['ace#2173', 'ace#2127', 'ace#2210'], note: 'multi-section file; provenance sits above the second describe' },
  'test/skills/upload-readback-contract.test.ts': { issues: ['ace#1831'], observed: 'hh-poverty-targeting/20260828-0702' },
  'test/skills/upstream-repo-slugs.test.ts': { issues: ['ace#1492'] },
  'test/skills/verdict-freshness-contract.test.ts': { issues: [], observed: 'spark-facilitator/20260828-0703' },
  'test/skills/widget-handoff-no-phantom-paste-target.test.ts': { issues: ['ace#1811', 'ace#1680', 'ace#1026'], observed: 'hh-poverty-targeting/20260828-0702' },
  'test/skills/work-order-hedging-pronoun-consistency.test.ts': { issues: ['ace#2164'], observed: 'bednet-check-2-visit/20260907-1126' },
  'test/skills/work-order-period-of-performance-producer.test.ts': { issues: ['ace#1781', 'ace#1092'], observed: 'hh-poverty-targeting/20260828-0702' },
  'test/skills/work-order-template-token-contract.test.ts': { issues: ['ace#1521', 'ace#1004', 'ace#1371', 'ace#819'] },
  'test/skills/worker-facing-no-widget-url.test.ts': { issues: ['ace#1669', 'ace#1303', 'ace#1026'], observed: 'hh-poverty-targeting/20260824-1404' },
};

/**
 * Rails with no discoverable provenance, 2026-09-16. Ratcheted DOWNWARD: an
 * entry leaves by someone attaching it to a real incident, or by the rail
 * being deleted. It may not grow.
 */
export const UNKNOWN_PROVENANCE_BASELINE = 5;

/**
 * Rails whose provenance is a measured population rather than an incident,
 * 2026-09-16. Ratcheted the same way, for the same reason: a free-text field
 * that nothing bounds is how "declare provenance" quietly becomes "write a
 * sentence".
 */
export const MEASUREMENT_PROVENANCE_BASELINE = 1;
