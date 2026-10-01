#!/usr/bin/env npx tsx
/**
 * Capture a rendered Google Slides deck for `training-deck-render-eval`.
 *
 *   npx tsx scripts/deck-visual-capture.ts --deck <presentationId> --out <dir> [--all]
 *
 * Reads the deck through the Slides API with the Drive service account (the
 * same key ace-gdrive uses — headless, no browser), runs the structural
 * pre-checks (`lib/deck-visual-checks.ts`), and downloads a 1600px thumbnail
 * (`presentations.pages.getThumbnail`, LARGE) of every slide the judge must
 * look at (`slidesToJudge`; `--all` for every slide). Writes
 * `<dir>/slides.json` — `{deck, slide_count, judged: [index], slides: [{index,
 * objectId, text, images, findings, png?}]}` — and `<dir>/slide-NN.png`.
 * Prints a one-line JSON summary on stdout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { checkRenderedDeck, slidesToJudge, type PresentationJson } from '../lib/deck-visual-checks.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before the first credential read (GOOGLE_APPLICATION_CREDENTIALS) — ace#1957.
loadPluginEnv(import.meta.url);

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const deck = arg('deck');
const out = arg('out');
if (!deck || !out) {
  process.stderr.write('deck-visual-capture: --deck and --out are required\n');
  process.exit(2);
}

function keyFile(): string {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const data = resolvePluginDataDir(import.meta.url);
  const p = data ? path.join(data, 'gws-sa-key.json') : '';
  if (p && fs.existsSync(p)) return p;
  throw new Error('no Drive service-account key (gws-sa-key.json) — run /ace:setup');
}

async function main(): Promise<void> {
  fs.mkdirSync(out as string, { recursive: true });
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFile(),
    scopes: ['https://www.googleapis.com/auth/presentations.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const slides = google.slides({ version: 'v1', auth });
  const pres = (await slides.presentations.get({ presentationId: deck as string })).data as PresentationJson;
  const reports = checkRenderedDeck(pres);
  const judged = args.includes('--all') ? reports.map((r) => r.index) : slidesToJudge(reports);
  const pngs = new Map<number, string>();
  for (const idx of judged) {
    const r = reports[idx - 1];
    // getThumbnail is an "expensive read" — retry once on a rate limit.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t = await slides.presentations.pages.getThumbnail({
          presentationId: deck as string,
          pageObjectId: r.objectId,
          'thumbnailProperties.thumbnailSize': 'LARGE',
        } as never);
        const url = (t.data as { contentUrl?: string }).contentUrl;
        if (!url) break;
        const res = await fetch(url);
        const file = path.join(out as string, `slide-${String(idx).padStart(2, '0')}.png`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        pngs.set(idx, file);
        break;
      } catch (err) {
        if (attempt === 2) process.stderr.write(`slide ${idx}: thumbnail failed — ${(err as Error).message}\n`);
        else await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
      }
    }
  }
  const doc = {
    deck,
    slide_count: reports.length,
    judged,
    slides: reports.map((r) => ({ ...r, ...(pngs.has(r.index) ? { png: pngs.get(r.index) } : {}) })),
  };
  fs.writeFileSync(path.join(out as string, 'slides.json'), JSON.stringify(doc, null, 2));
  const flagged = reports.filter((r) => r.findings.length);
  process.stdout.write(
    JSON.stringify({ deck, slide_count: reports.length, judged: judged.length, thumbnails: pngs.size, flagged: flagged.map((r) => ({ index: r.index, findings: r.findings.map((f) => f.kind) })) }) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`deck-visual-capture: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
