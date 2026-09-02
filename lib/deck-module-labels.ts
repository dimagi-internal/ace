//
// Pure static check: does the training deck number the Learn modules the same
// way the Learn app does?
//
// The defect (dimagi-internal/ace#1829). `training-deck-generate` numbered the
// Learn modules TWO incompatible ways in one deck. On
// `hh-poverty-targeting/20260828-0702` the reference section (slides 16-19) was
// correct — "Module 1 — Administering a Scorecard Neutrally" — while the
// practice section (slides 34-39) renumbered the whole suite because it counted
// the unnumbered Pre-Assessment as Module 1:
//
//     app  : Pre-Assessment | Module 1 - Administering… | Module 2 - Consent… | …
//     deck : Module 1: Pre-Assessment | Module 2: Administering… | Module 3: Consent… | …
//
// Slide 14 carried the contradiction on ONE slide, next to its own evidence: an
// ordinal 1-6 list whose item `4. What makes a visit payable` sat beside the
// suite-root screenshot labelling that same item "Module 3".
//
// Why it matters more than a typo: slides 34-39 are TIMED hands-on instructions
// ("Complete Learn Module 4: What Makes a Visit Payable", 20 min). A first-day
// FLW follows the deck, opens the app, finds no Module 4 by that name — it is
// Module 3 — and stalls inside a timed block. This is FLW-facing material
// instructing a worker to do something impossible.
//
// Root cause: the generator derived practice-slide titles from a slide's own
// ordinal POSITION in the section list rather than from the labels the Learn
// app actually ships. Nothing bound deck labels to the app's module names, so a
// deck could name a module that does not exist. The producer's step-11
// self-eval counted slides — it never read one.
//
// So the rule this module enforces is: **module labels shown to a worker are
// lifted verbatim from the Learn app; the deck never synthesises an ordinal.**
// The app's names already carry their own numbers, which is precisely why
// re-deriving one can only ever disagree.
//
// The authoritative names are available two ways on every run, and they agree:
// `3-commcare/pdd-to-learn-app_summary.md`, and the capture manifest's
// `learn-tap-module-after-<name>.png` step names.
//
// Same family as `lib/screen-shape.ts` / `lib/derived-chain-guard.ts`: fully
// mechanical, so it is a parser rather than a rubric line.
//

/** One slide, duck-typed so this does not couple to the zod spec schema. */
export interface DeckSlideLabel {
  id?: string;
  title?: string;
  /** Body lines (or one blob). Numbered lists live here — slide 14's shape. */
  body?: string | string[];
  /** The spec module this slide belongs to, for the finding's locator. */
  module?: string;
}

export type DeckLabelFindingKind =
  | 'module-number-mismatch'
  | 'module-number-not-in-app'
  | 'module-name-not-in-app';

export interface DeckLabelFinding {
  kind: DeckLabelFindingKind;
  /** Where it was found. */
  slideId: string;
  module?: string;
  /** The offending text, verbatim. */
  text: string;
  /** The number the DECK asserts. */
  deckNumber: number;
  /** The number the APP assigns to this module, when it has one. */
  appNumber?: number;
  /** The app's label, verbatim, when the name resolved. */
  appLabel?: string;
  detail: string;
}

export interface DeckLabelReport {
  /** Slides examined. */
  slidesChecked: number;
  /** Numbered module labels found in the deck. */
  labelsChecked: number;
  /** The app's numbered modules, `number -> verbatim label`. */
  appModules: Record<number, string>;
  findings: DeckLabelFinding[];
}

/** Normalise a module title for comparison: case, punctuation, whitespace. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Strip a leading `Module N -` / `Module N:` prefix, returning the bare title.
 *
 * The app's own labels carry their number, so the bare title is the only part
 * that can be compared across the two numbering schemes.
 */
export function bareTitle(label: string): string {
  return label.replace(/^\s*module\s+\d+\s*[-–—:.]?\s*/i, '').trim();
}

/** `Module N` in a title/body line, with whatever title follows it. */
const MODULE_LABEL = /module\s+(\d+)\s*[-–—:.]?\s*([^\n|]*)/gi;

/** A numbered list item: `4. What makes a visit payable`. */
const ORDINAL_ITEM = /^\s*(\d+)\s*[.)]\s+(.+?)\s*$/;

function bodyLines(body: DeckSlideLabel['body']): string[] {
  if (!body) return [];
  return Array.isArray(body) ? body : body.split('\n');
}

/**
 * Check every module label the deck shows a worker against the Learn app's own
 * module names.
 *
 * `learnModuleLabels` is the app's list, in app order, verbatim — including
 * unnumbered entries like `Pre-Assessment`, because their presence is exactly
 * what caused the off-by-one.
 */
export function checkDeckModuleLabels(
  slides: DeckSlideLabel[],
  learnModuleLabels: string[],
): DeckLabelReport {
  /** number -> verbatim app label, for the modules the APP numbers. */
  const appModules: Record<number, string> = {};
  /** normalised bare title -> the number the app gives it (or null if unnumbered). */
  const numberOfTitle = new Map<string, number | null>();

  for (const label of learnModuleLabels) {
    const m = /^\s*module\s+(\d+)\b/i.exec(label);
    const bare = normalizeTitle(bareTitle(label));
    if (m) {
      const n = Number(m[1]);
      appModules[n] = label;
      numberOfTitle.set(bare, n);
    } else {
      numberOfTitle.set(bare, null);
    }
  }

  const findings: DeckLabelFinding[] = [];
  let labelsChecked = 0;
  const seen = new Set<string>();

  const record = (f: DeckLabelFinding) => {
    const key = `${f.slideId}|${f.kind}|${f.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const [i, slide] of slides.entries()) {
    const slideId = slide.id ?? slide.title ?? `slide-${i + 1}`;
    const texts = [slide.title ?? '', ...bodyLines(slide.body)];

    for (const raw of texts) {
      if (!raw.trim()) continue;

      // Shape 1 — an explicit `Module N: <title>` the deck asserts.
      for (const m of raw.matchAll(MODULE_LABEL)) {
        const deckNumber = Number(m[1]);
        const claimed = normalizeTitle(m[2] ?? '');
        labelsChecked++;

        if (!claimed) {
          // Bare "Module N" with no title: only checkable against existence.
          if (!(deckNumber in appModules)) {
            record({
              kind: 'module-number-not-in-app',
              slideId,
              module: slide.module,
              text: raw.trim(),
              deckNumber,
              detail:
                `The deck tells a worker to open "Module ${deckNumber}", but the ` +
                `Learn app numbers only ${Object.keys(appModules).join(', ') || '(none)'}. ` +
                `They will open the app and find no such module.`,
            });
          }
          continue;
        }

        const appNumber = numberOfTitle.get(claimed);
        if (appNumber === undefined && !(deckNumber in appModules)) {
          // Neither the name NOR the number resolves. The actionable fact is
          // that no such module exists at all — say that, not "wrong title".
          record({
            kind: 'module-number-not-in-app',
            slideId,
            module: slide.module,
            text: raw.trim(),
            deckNumber,
            detail:
              `The deck tells a worker to open "Module ${deckNumber}", but the ` +
              `Learn app numbers only ${Object.keys(appModules).join(', ') || '(none)'}. ` +
              `They will open the app and find no such module.`,
          });
        } else if (appNumber === undefined) {
          record({
            kind: 'module-name-not-in-app',
            slideId,
            module: slide.module,
            text: raw.trim(),
            deckNumber,
            detail:
              `The deck names a Learn module "${(m[2] ?? '').trim()}" that the ` +
              `deployed Learn app does not ship. Module labels shown to a worker ` +
              `must be lifted verbatim from the app.`,
          });
        } else if (appNumber === null) {
          record({
            kind: 'module-number-mismatch',
            slideId,
            module: slide.module,
            text: raw.trim(),
            deckNumber,
            appLabel: learnModuleLabels.find((l) => normalizeTitle(bareTitle(l)) === claimed),
            detail:
              `The deck calls it "Module ${deckNumber}", but the Learn app ships ` +
              `it UNNUMBERED. Counting an unnumbered entry as a module is what ` +
              `shifts every real module up by one (ace#1829).`,
          });
        } else if (appNumber !== deckNumber) {
          record({
            kind: 'module-number-mismatch',
            slideId,
            module: slide.module,
            text: raw.trim(),
            deckNumber,
            appNumber,
            appLabel: appModules[appNumber],
            detail:
              `The deck calls it "Module ${deckNumber}"; the Learn app calls it ` +
              `"${appModules[appNumber]}". A worker following this slide opens ` +
              `the app and finds a different module under that number.`,
          });
        }
      }

      // Shape 2 — a numbered list item naming a module by its bare title, with
      // no "Module" keyword. This is slide 14: `4. What makes a visit payable`
      // printed beside the screenshot that labels it Module 3.
      const ord = ORDINAL_ITEM.exec(raw);
      if (ord) {
        const claimed = normalizeTitle(ord[2]);
        const appNumber = numberOfTitle.get(claimed);
        if (appNumber !== undefined && appNumber !== null) {
          labelsChecked++;
          const deckNumber = Number(ord[1]);
          if (appNumber !== deckNumber) {
            record({
              kind: 'module-number-mismatch',
              slideId,
              module: slide.module,
              text: raw.trim(),
              deckNumber,
              appNumber,
              appLabel: appModules[appNumber],
              detail:
                `An ordinal list gives this module position ${deckNumber}, but the ` +
                `Learn app labels it "${appModules[appNumber]}". A worker reads ` +
                `the list and the app's own tile as contradicting each other.`,
            });
          }
        }
      }
    }
  }

  return {
    slidesChecked: slides.length,
    labelsChecked,
    appModules,
    findings,
  };
}

/** Human-readable one-block report for the producer's self-eval. */
export function formatDeckLabelReport(r: DeckLabelReport): string {
  const appList = Object.entries(r.appModules)
    .map(([n, l]) => `${n}="${l}"`)
    .join(', ');
  if (r.findings.length === 0) {
    return (
      `deck module labels: OK — ${r.labelsChecked} label(s) across ` +
      `${r.slidesChecked} slide(s) agree with the Learn app [${appList || 'no numbered modules'}].`
    );
  }
  const lines = [
    `deck module labels: ${r.findings.length} MISMATCH(es) across ${r.slidesChecked} slide(s). ` +
      `App numbering: [${appList || 'no numbered modules'}].`,
  ];
  for (const f of r.findings) {
    lines.push(`  - [${f.kind}] ${f.slideId}: ${f.text}`);
    lines.push(`      ${f.detail}`);
  }
  return lines.join('\n');
}
