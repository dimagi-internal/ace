import { describe, it, expect } from 'vitest';
import { classifyMediaFolder, type DriveEntry } from './media-guidance.js';

const e = (name: string, mime: string, id = name): DriveEntry => ({
  file_id: id,
  name,
  mime_type: mime,
});

const PNG = 'image/png';
const GDOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';

describe('classifyMediaFolder — media assets', () => {
  it('classifies the three Nova-supported kinds by mime type', () => {
    const r = classifyMediaFolder([
      e('a.png', PNG),
      e('b.jpg', 'image/jpeg'),
      e('c.mp3', 'audio/mpeg'),
      e('d.mp4', 'video/mp4'),
    ]);
    expect(r.assets.map((a) => a.kind)).toEqual(['image', 'image', 'audio', 'video']);
  });

  it('falls back to the extension when Drive reports a generic mime type', () => {
    const r = classifyMediaFolder([e('diagram.png', 'application/octet-stream')]);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0].kind).toBe('image');
    expect(r.assets[0].mime_type).toBe('image/png');
  });

  it('rejects the audio containers CommCare HQ cannot ingest', () => {
    // CLAUDE.md / upload_media_asset: .m4a and .ogg are refused by HQ.
    const r = classifyMediaFolder([e('voice.m4a', 'audio/mp4'), e('voice.ogg', 'audio/ogg')]);
    expect(r.assets).toHaveLength(0);
    expect(r.unsupported.map((u) => u.name)).toEqual(['voice.m4a', 'voice.ogg']);
    expect(r.unsupported[0].reason).toMatch(/m4a|ingest/i);
  });

  it('ignores subfolders rather than treating them as assets', () => {
    const r = classifyMediaFolder([e('archive', FOLDER), e('a.png', PNG)]);
    expect(r.assets.map((a) => a.name)).toEqual(['a.png']);
    expect(r.ignored.map((i) => i.name)).toEqual(['archive']);
  });

  it('derives a stable kebab-case key per asset for binding and tracing', () => {
    const r = classifyMediaFolder([e('KMC Position_Demo.PNG', PNG)]);
    expect(r.assets[0].asset_key).toBe('kmc-position-demo');
  });

  it('disambiguates assets whose names collide after keying', () => {
    const r = classifyMediaFolder([
      e('cord stump.png', PNG, 'id-1'),
      e('Cord-Stump.jpg', 'image/jpeg', 'id-2'),
    ]);
    expect(r.assets.map((a) => a.asset_key)).toEqual(['cord-stump', 'cord-stump-2']);
  });
});

describe('classifyMediaFolder — guidance discovery', () => {
  it('treats any readable text document as guidance, whatever it is named', () => {
    const r = classifyMediaFolder([e('zzz-random-name.md', 'text/markdown'), e('a.png', PNG)]);
    expect(r.guidance.map((g) => g.name)).toEqual(['zzz-random-name.md']);
  });

  it('returns no guidance when the folder holds only media — a supported case, not an error', () => {
    const r = classifyMediaFolder([e('a.png', PNG)]);
    expect(r.guidance).toEqual([]);
    expect(r.assets).toHaveLength(1);
  });

  it('ranks name-affinity hits above neutral names without excluding either', () => {
    const r = classifyMediaFolder([
      e('notes-from-jan.md', 'text/markdown'),
      e('overview.gdoc', GDOC),
      e('scratch.txt', 'text/plain'),
    ]);
    expect(r.guidance.map((g) => g.name)).toEqual([
      'overview.gdoc',
      'notes-from-jan.md',
      'scratch.txt',
    ]);
    // every one of them is still guidance — ranking orders, it never filters
    expect(r.guidance).toHaveLength(3);
  });

  it.each([
    'overview.md',
    'SUMMARY.txt',
    'ReadMe.md',
    'how-to-use-these.md',
    'image-guide.md',
    'instructions.txt',
    'about the photos.md',
  ])('recognises %s as an affinity-ranked guidance name', (name) => {
    const r = classifyMediaFolder([e(name, 'text/markdown'), e('plain.md', 'text/markdown')]);
    expect(r.guidance[0].name).toBe(name);
    expect(r.guidance[0].affinity).toBeGreaterThan(0);
  });

  it('orders equal-affinity docs deterministically (shorter name, then alphabetical)', () => {
    const r = classifyMediaFolder([
      e('bbb.md', 'text/markdown'),
      e('aaa.md', 'text/markdown'),
      e('a.md', 'text/markdown'),
    ]);
    expect(r.guidance.map((g) => g.name)).toEqual(['a.md', 'aaa.md', 'bbb.md']);
  });

  it('surfaces a PDF as guidance that needs extraction rather than dropping it silently', () => {
    const r = classifyMediaFolder([e('brief.pdf', 'application/pdf')]);
    expect(r.guidance).toHaveLength(1);
    expect(r.guidance[0].needs_extraction).toBe(true);
    expect(r.assets).toHaveLength(0);
  });

  it('marks Google Docs and text files as directly readable', () => {
    const r = classifyMediaFolder([e('overview.gdoc', GDOC), e('notes.md', 'text/markdown')]);
    expect(r.guidance.every((g) => g.needs_extraction === false)).toBe(true);
  });
});

describe('classifyMediaFolder — whole-folder behaviour', () => {
  it('returns fully empty results for an empty folder without throwing', () => {
    const r = classifyMediaFolder([]);
    expect(r).toEqual({ assets: [], guidance: [], unsupported: [], ignored: [] });
  });

  it('resolves a shortcut to its target mime type', () => {
    const r = classifyMediaFolder([
      {
        file_id: 'shortcut-1',
        name: 'linked.png',
        mime_type: 'application/vnd.google-apps.shortcut',
        resolved_target_id: 'real-1',
        resolved_target_mime_type: PNG,
      },
    ]);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0].file_id).toBe('real-1');
    expect(r.assets[0].kind).toBe('image');
  });

  it('is a pure function of its input ordering — same input, same output', () => {
    const input = [e('b.png', PNG), e('overview.md', 'text/markdown'), e('a.png', PNG)];
    expect(classifyMediaFolder(input)).toEqual(classifyMediaFolder(input));
  });
});
