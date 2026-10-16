/**
 * Render a composited common-pool frame (dimagi-internal/ace#3060).
 * Rules + rationale: lib/screenshot-composite.ts. Illustration only, never evidence.
 *
 *   npx tsx scripts/composite-pool-frame.ts \
 *     --spec templates/training-deck/_common/composites/connect-2.64.0.yaml \
 *     --frame connect-home --base <capture.png> --dump <capture.xml> \
 *     --font <Roboto-Regular.ttf> --out <out.png>
 *
 * Writes <out.png> and <out.png>.provenance.json, and prints the provenance.
 * Refuses when the base capture's sha256 differs from the spec's, or when any
 * text element in the dump is not covered by a keep/replace rule.
 *
 * The pixel work runs in Playwright's Chromium (already an ACE dependency), so
 * no image library is added. Per element: the background is each row's most
 * common colour inside the element's bounds (which holds for flat fills and
 * for vertical gradients); the ink colour and the ink's top-left corner come
 * from the original glyph pixels. The rows are repainted with that background,
 * and the replacement text is drawn so its cap height starts where the
 * original's did.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { chromium } from 'playwright';
import {
  compositeProvenance,
  parseUiTextNodes,
  planComposite,
  type CompositeFrameSpec,
  type PaintOp,
} from '../lib/screenshot-composite.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const specFile = parseYaml(readFileSync(arg('spec'), 'utf8')) as {
  font?: { sha256?: string };
  frames: Record<string, CompositeFrameSpec>;
};
const frame = arg('frame');
const spec = specFile.frames?.[frame];
if (!spec) throw new Error(`frame '${frame}' not in ${arg('spec')}`);

const base = readFileSync(arg('base'));
const sha = createHash('sha256').update(base).digest('hex');
if (sha !== spec.base.sha256) {
  throw new Error(`base capture sha256 ${sha} != spec ${spec.base.sha256}; re-capture or update the spec deliberately`);
}
const ops = planComposite(parseUiTextNodes(readFileSync(arg('dump'), 'utf8')), spec);
const font = readFileSync(arg('font'));
const fontSha = createHash('sha256').update(font).digest('hex');
if (specFile.font?.sha256 && fontSha !== specFile.font.sha256) {
  throw new Error(`font sha256 ${fontSha} != spec ${specFile.font.sha256}; pull the font from a device running this APK`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // tsx (esbuild keepNames) wraps named functions in `__name(...)`, which the
  // page context does not define; give it the identity helper first.
  await page.evaluate('globalThis.__name = (f) => f');
  const dataUrl = await page.evaluate(
    async ({ png, ttf, ops }: { png: string; ttf: string; ops: PaintOp[] }) => {
      const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const face = new FontFace('Roboto', bytes(ttf), { weight: '100 900' });
      await face.load();
      (document as any).fonts.add(face);
      const img = await createImageBitmap(new Blob([bytes(png)], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);

      const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      for (const op of ops) {
        const [x0, y0, x1, y1] = op.rect;
        const w = Math.min(x1, canvas.width) - x0;
        const h = Math.min(y1, canvas.height) - y0;
        const d = ctx.getImageData(x0, y0, w, h).data;
        const px = (x: number, y: number) => {
          const i = (y * w + x) * 4;
          return [d[i], d[i + 1], d[i + 2]];
        };
        // Background per row, sampled from the 6 columns just OUTSIDE each side
        // of the element. Sampling inside fails on dense bold text, where a row
        // through the strokes is mostly ink. Falls back to the in-rect mode when
        // the element spans the full width.
        const outL = Math.max(0, x0 - 6);
        const outR = Math.min(canvas.width, x0 + w + 6);
        const strip = ctx.getImageData(outL, y0, outR - outL, h).data;
        const sw = outR - outL;
        const bg: number[][] = [];
        for (let y = 0; y < h; y++) {
          const counts = new Map<string, number>();
          const add = (x: number, data: Uint8ClampedArray, width: number) => {
            const i = (y * width + x) * 4;
            const k = `${data[i]},${data[i + 1]},${data[i + 2]}`;
            counts.set(k, (counts.get(k) ?? 0) + 1);
          };
          for (let x = 0; x < x0 - outL; x++) add(x, strip, sw);
          for (let x = x0 - outL + w; x < sw; x++) add(x, strip, sw);
          if (counts.size === 0) for (let x = 0; x < w; x++) add(x, d, w);
          bg.push([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number));
        }
        let inkTop = -1;
        let inkLeft = w;
        let maxD = 0;
        let ink = [0, 0, 0];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dd = dist(px(x, y), bg[y]);
            if (dd > 120) {
              if (inkTop < 0) inkTop = y;
              if (x < inkLeft) inkLeft = x;
            }
            if (dd > maxD) {
              maxD = dd;
              ink = px(x, y);
            }
          }
        }
        if (inkTop < 0) throw new Error(`no ink found in ${op.id}[${op.index}]`);
        for (let y = 0; y < h; y++) {
          ctx.fillStyle = `rgb(${bg[y].join(',')})`;
          ctx.fillRect(x0, y0 + y, w, 1);
        }
        ctx.font = `${op.weight} ${op.fontPx}px Roboto`;
        ctx.fillStyle = `rgb(${ink.join(',')})`;
        ctx.textBaseline = 'alphabetic';
        const capAscent = ctx.measureText('H').actualBoundingBoxAscent;
        const maxW = w - inkLeft;
        const lines: string[] = [];
        for (const para of op.text.split('\n')) {
          let line = '';
          for (const word of para.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(next).width > maxW) {
              lines.push(line);
              line = word;
            } else line = next;
          }
          lines.push(line);
        }
        lines.forEach((l, i) => ctx.fillText(l, x0 + inkLeft, y0 + inkTop + capAscent + i * op.linePx));
      }
      return canvas.toDataURL('image/png');
    },
    { png: base.toString('base64'), ttf: font.toString('base64'), ops },
  );
  const out = arg('out');
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const prov = {
    ...compositeProvenance(spec, ops),
    sha256: createHash('sha256').update(readFileSync(out)).digest('hex'),
  };
  writeFileSync(`${out}.provenance.json`, JSON.stringify(prov, null, 2));
  console.log(JSON.stringify(prov));
} finally {
  await browser.close();
}
