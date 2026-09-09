import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  AgendaSlideSchema,
  ExerciseSlideSchema,
  STENCIL_PLACEHOLDERS,
} from '../../lib/training-deck-spec';
import { buildExerciseTextBoxes } from '../../lib/training-deck-stencil-geometry';

/**
 * A training deck states NO time durations. The LLO sets session timing.
 *
 * ## Why
 *
 * Operator decision, 2026-09-09. Every duration ACE printed on a training
 * deck was invented: the deck is authored before anyone knows the room, the
 * group size, the literacy mix, or how long the FLWs' questions will run.
 * Printing "Payments — 20 min" on an agenda does not inform the LLO, it
 * quietly overrides them, and it makes an invented number look agreed.
 *
 * ## The distinction this test protects
 *
 * The ban is on TRAINING-SCHEDULE timings, not on PROGRAM parameters, and the
 * two are easy to conflate:
 *
 *   banned  — how long the training day runs, how long a module takes, how
 *             long to spend on an exercise, a session total in a speaker note
 *   REQUIRED — how long an FGD session must run (75-90 min), how many
 *             participants a group holds (6-12), that the attestation is due
 *             within 24 hours and the session doc within 72
 *
 * The second set comes from the PDD and is what the FLW is being paid to
 * comply with. Stripping it would not be deference to the LLO; it would be
 * withholding the job description. So the assertions below are deliberately
 * narrow — they pin the schema and the training templates, and they explicitly
 * assert the FGD protocol figures SURVIVE, so a future "remove all the
 * numbers" pass cannot quietly gut the FGD deck.
 *
 * `connect-pitch-partnership` is out of scope throughout: it is a
 * prospect-facing pitch, not training, and its duration is the length of an
 * accompanying video, which ACE does control.
 */

const REPO = join(__dirname, '..', '..');
const VARIANTS = join(REPO, 'templates', 'training-deck');
const TRAINING_VARIANTS = ['connect-training-atomic', 'connect-training-fgd'];

describe('training decks state no durations', () => {
  it('AgendaSlideSchema has no duration on items, and strips one if supplied', () => {
    const parsed = AgendaSlideSchema.parse({
      id: 'agenda',
      layout: 'agenda',
      title: "Today's Agenda",
      items: [{ label: 'Payments', duration: '20 min' }],
    });
    // Stripped rather than rejected: a generator that still emits a duration
    // should lose the value, not blow up a run mid-flight.
    expect(parsed.items[0]).toEqual({ label: 'Payments' });
    expect(JSON.stringify(parsed)).not.toContain('20 min');
  });

  it('ExerciseSlideSchema has no duration, and strips one if supplied', () => {
    const parsed = ExerciseSlideSchema.parse({
      id: 'icebreaker',
      layout: 'exercise',
      title: 'Two Truths and a Lie',
      duration: '10 min',
      body: 'Each person shares three statements.',
    });
    expect(parsed).not.toHaveProperty('duration');
    expect(JSON.stringify(parsed)).not.toContain('10 min');
  });

  it('the exercise layout no longer declares a {{DURATION}} placeholder', () => {
    // If this list kept {{DURATION}} after the renderer stopped replacing it,
    // every exercise slide would ship the literal token to an FLW.
    expect(STENCIL_PLACEHOLDERS.exercise).not.toContain('{{DURATION}}');
    expect(STENCIL_PLACEHOLDERS.exercise).toEqual(['{{BODY}}', '{{TITLE}}']);
  });

  it('the exercise stencil builds no duration text box', () => {
    // Counterpart to the placeholder contract above: the geometry must not
    // create a frame that nothing fills. Asserted via the built requests
    // rather than by reading the source, so a refactor cannot pass it.
    const requests = buildExerciseTextBoxes('p1');
    const ids = JSON.stringify(requests);
    expect(ids).not.toContain('_duration');
    expect(ids).not.toContain('{{DURATION}}');
  });

  it('no training variant declares a duration field or token', () => {
    const offenders: string[] = [];
    for (const variant of TRAINING_VARIANTS) {
      const dir = join(VARIANTS, variant);
      for (const file of readdirSync(dir)) {
        if (!/\.(yaml|yml)$/.test(file)) continue;
        const body = readFileSync(join(dir, file), 'utf8');
        body.split('\n').forEach((line, i) => {
          // Comments explaining the ban are fine; declarations are not.
          if (/^\s*#/.test(line)) return;
          if (/^\s*(duration|estimated_duration_minutes|expected_duration_minutes)\s*:/.test(line)) {
            offenders.push(`${variant}/${file}:${i + 1}: ${line.trim()}`);
          }
          if (/\{\{[A-Z_]*DURATION[A-Z_]*\}\}/.test(line)) {
            offenders.push(`${variant}/${file}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(
      offenders,
      'Training decks state no durations — the LLO sets session timing.\n' +
        'Remove these declarations. Program parameters from the PDD (FGD session\n' +
        'length, participant counts, submission deadlines) belong in slide BODY\n' +
        'text, not in a duration field.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no training variant PROSE instructs the generator to emit a duration', () => {
    // The gap this closes (ace#2331). The scan above reads only `.yaml`, and the
    // schemas strip a `duration` KEY — so both miss the case that actually
    // reached a deck: `generate.prompt.md` telling the model, in prose, to put a
    // duration in a slide's BODY. Body text is free-form and budget-checked, not
    // key-checked, so nothing downstream could catch it. Measured on
    // connect-training-atomic/generate.prompt.md, which said "Emit NO durations"
    // on line 27 and "Duration: 15-25 min per module based on content density"
    // on line 103 — the second silently won, because it was the instruction
    // sitting next to the slide it described.
    //
    // The matchers are deliberately narrow, for the same reason the yaml scan
    // is: they must not fire on the FGD's PDD-derived program parameters
    // ("Session duration (typically 75-90 min)"), nor on the prose that explains
    // the ban. So they require either a numeric ASSIGNMENT (`Duration: 15`) or a
    // time quantity bound to a per-unit training phrase ("15-25 min per module").
    const TIME = String.raw`\d+\s*(?:[-–]\s*\d+\s*)?(?:min|mins|minutes|hours?|hrs?)\b`;
    const UNIT = String.raw`per\s+(?:module|slide|exercise|activity|section|topic)\b`;
    const PATTERNS: Array<[RegExp, string]> = [
      [/\bdurations?\s*:\s*\d/i, 'a numeric duration assignment'],
      [new RegExp(`${TIME}[^.\\n]{0,40}${UNIT}`, 'i'), 'a per-unit training timing'],
      [new RegExp(`${UNIT}[^.\\n]{0,40}${TIME}`, 'i'), 'a per-unit training timing'],
    ];

    const offenders: string[] = [];
    for (const variant of TRAINING_VARIANTS) {
      const file = join(VARIANTS, variant, 'generate.prompt.md');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const [re, why] of PATTERNS) {
            if (re.test(line)) {
              offenders.push(`${variant}/generate.prompt.md:${i + 1}: ${why}: ${line.trim()}`);
            }
          }
        });
    }
    expect(
      offenders,
      'A training-deck prompt must not instruct the generator to state a\n' +
        'duration — the LLO sets session timing, and a duration in BODY text\n' +
        'is invisible to both the schema strip and the yaml scan.\n\n' +
        'If the figure is a PDD PROGRAM parameter (how long an FGD session must\n' +
        'run, a submission deadline), phrase it as the requirement it is rather\n' +
        'than as a per-module allowance.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the atomic prompt still carries the no-durations rule it is scanned against', () => {
    // Counter-ratchet for the test above: deleting the rule must not be a way
    // to make the scan pass.
    const prompt = readFileSync(
      join(VARIANTS, 'connect-training-atomic', 'generate.prompt.md'),
      'utf8',
    );
    expect(prompt).toMatch(/Emit NO durations/);
  });

  it('the shared facilitation module carries no durations', () => {
    const doc = yaml.load(
      readFileSync(join(VARIANTS, '_common', 'facilitation.yaml'), 'utf8'),
    ) as Record<string, Array<Record<string, unknown>>>;
    for (const key of ['icebreakers', 'practice_patterns']) {
      expect(doc[key].length).toBeGreaterThan(0);
      for (const entry of doc[key]) {
        expect(entry).not.toHaveProperty('duration');
        // The activity itself must survive the duration removal.
        expect(String(entry.body ?? '').length).toBeGreaterThan(10);
      }
    }
  });

  it('FGD PROGRAM parameters survive — this is the counter-ratchet', () => {
    // The failure mode this guards: someone reads "no durations anywhere",
    // greps for time units, and deletes the FGD session length and the
    // submission deadlines. That produces a deck which never tells the worker
    // what they are being paid to do.
    const prompt = readFileSync(
      join(VARIANTS, 'connect-training-fgd', 'generate.prompt.md'),
      'utf8',
    );
    expect(prompt).toMatch(/75-90 min/);
    expect(prompt).toMatch(/within 24 hours/);
    expect(prompt).toMatch(/within 72 hours/);
    expect(prompt).toMatch(/6-12/);
  });
});
