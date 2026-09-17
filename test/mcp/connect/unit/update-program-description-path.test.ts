/**
 * ace#2291 — `connect_update_program` took `description` INLINE ONLY, while
 * every sibling atom that moves a large payload had a from-disk handle:
 * `drive_create_file` / `drive_update_file` / `update_yaml_file`
 * (`localFilePath`), and, in this same server, `new_xform_xml_path`,
 * `file_bytes_path`, `ccz_path` and the read-side `write_to_path`.
 *
 * The cost is per-run and permanent, not one-off. `connect-program-setup`
 * § Step 3a refreshes a reused program's description against the current
 * run's PDD on EVERY reuse, and reuse is the normal path for every run after
 * an opp's first. A program description is the whole programme design in
 * prose: measured LIVE 2026-09-17 against the issue's own repro program
 * (`efb8af66-fbfd-488f-bf99-66f864cea68b`, `ai-demo-space`) it is 21,012
 * chars — ~5.8k output tokens re-emitted every run, for text the step just
 * authored to a file.
 *
 * And there is a correctness half. The step writes the refreshed description
 * to a file, runs `reconcileProgramWithPdd` against THAT, and then re-emitted
 * the same prose inline for the update — two generations, not one copy, with
 * nothing making them match. That is the ace#1737 class, where an archived
 * manifest did not even parse as YAML while generation had succeeded.
 *
 * So the property pinned here is the one ace#1737 taught, the same one
 * test/scripts/run-labs-synthetic-generate.test.ts pins for labs: **the bytes
 * sent are the bytes on disk** — including the pathological shapes, because a
 * well-meaning trim/normalise inside the resolver would reintroduce the exact
 * defect while every other test stayed green.
 *
 * Source-level assertions on the registration follow
 * test/mcp/connect/registration-signature-drift.test.ts: `mcp/connect-server.ts`
 * does a top-level `await server.connect(transport)`, so importing it connects
 * stdio (ace#1448 is why the registration is checked at all — a fix can land in
 * the backend and never reach `server.tool(...)`).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOptionalInlineOrPath,
  AtomArgUsageError,
} from '../../../../lib/atom-payload-resolver.js';
import { PathContainmentError } from '../../../../lib/contained-path.js';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

const REPO = join(__dirname, '../../../..');
const serverSrc = readFileSync(join(REPO, 'mcp/connect-server.ts'), 'utf8');

const ATOM = {
  atom: 'connect_update_program',
  inlineParam: 'description',
  pathParam: 'description_path',
} as const;

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-progdesc-'));
  const p = join(dir, name);
  writeFileSync(p, body, 'utf-8');
  return p;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A real program description's shape: markdown headings, an em-dash, smart
 * quotes, a payment predicate carrying `!=`, an XPath `concat(...)`, a table,
 * and a trailing newline. Every one of these survives a file read and would
 * survive a model re-emission only by luck.
 */
const DESCRIPTION = [
  '# Bednet Check — 2-Visit Study',
  '',
  'Archetype: longitudinal-visits, and deliberately NOT multi-stage.',
  '',
  '## Payment',
  '',
  'A visit is payable only when `consent_confirmed != yes` is FALSE — this is a',
  'payment predicate, not a display hint.',
  '',
  '| Field | Rule |',
  '|---|---|',
  '| case name | concat(household_id, \'-\', visit_round) |',
  '',
  '“Return after three days” is the worker-facing instruction.',
  '',
].join('\n');

describe('resolver contract — at most one, never a silent empty (ace#2291)', () => {
  it('refuses BOTH description and description_path, in the sibling atoms’ wording', () => {
    const p = tmpFile('d.md', DESCRIPTION);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, inline: 'x', path: p }))
      .toThrow(/connect_update_program: pass exactly one of description or description_path, not both/);
  });

  it('allows NEITHER — unlike the gdrive resolvers, because a dates-only update is legal', () => {
    // `connect_update_program` refreshes name/description/budget/start_date/
    // end_date independently. Borrowing resolveInlineOrLocalFile's
    // exactly-one rule would have broken every update that does not touch
    // the description.
    expect(resolveOptionalInlineOrPath({ ...ATOM })).toBeUndefined();
  });

  it('passes an inline description through untouched', () => {
    expect(resolveOptionalInlineOrPath({ ...ATOM, inline: DESCRIPTION })).toBe(DESCRIPTION);
  });

  it('reads the file bytes VERBATIM — no trim, no parse, no re-serialisation', () => {
    const p = tmpFile('program-description.md', DESCRIPTION);
    expect(resolveOptionalInlineOrPath({ ...ATOM, path: p })).toBe(DESCRIPTION);
  });

  it('preserves leading/trailing whitespace, CRLF and unicode', () => {
    // The shape a "helpful" .trim() or line-ending normalisation destroys —
    // and a destroyed description is published to a live LLO-facing surface.
    const odd = '\n  # Título — programme\r\n\r\n“smart” quotes, café, 100 % \n\n';
    const p = tmpFile('d.md', odd);
    expect(resolveOptionalInlineOrPath({ ...ATOM, path: p })).toBe(odd);
  });

  it('is byte-identical to what the reconciler read from the same file', () => {
    // The ace#1737 property stated directly: one file, two consumers, equal by
    // construction rather than by the author re-emitting the prose correctly.
    const p = tmpFile('program-description.md', DESCRIPTION);
    const readByReconciler = readFileSync(p, 'utf-8');
    expect(resolveOptionalInlineOrPath({ ...ATOM, path: p })).toBe(readByReconciler);
  });
});

describe('a bad path is a TYPED refusal naming it, never a blanked description', () => {
  it('refuses a missing path by name, and says nothing was sent', () => {
    const missing = join(tmpdir(), 'ace-progdesc-nope', 'program-description.md');
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: missing })).toThrow(AtomArgUsageError);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: missing }))
      .toThrow(/unreadable_description_path/);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: missing }))
      .toThrow(new RegExp(escapeRe(missing)));
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: missing }))
      .toThrow(/Nothing was sent/);
  });

  it('refuses an unreadable path that exists but is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-progdesc-'));
    const sub = join(dir, 'descriptions');
    mkdirSync(sub);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: sub }))
      .toThrow(/unreadable_description_path/);
  });

  it('refuses an EMPTY file rather than blanking a live description', () => {
    // The failure the issue names: "refusing an unreadable path by name rather
    // than silently sending empty". A truncated author step must not be able
    // to wipe an LLO-facing programme design and report success.
    const p = tmpFile('d.md', '');
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: p })).toThrow(/empty_description_path/);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: p })).toThrow(new RegExp(escapeRe(p)));
  });

  it('refuses a whitespace-only file for the same reason', () => {
    const p = tmpFile('d.md', '\n\n   \t\n');
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: p })).toThrow(/empty_description_path/);
  });

  it('refuses a RELATIVE path — the server’s cwd is the plugin cache, not the caller’s project', () => {
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: 'program-description.md' }))
      .toThrow(/description_path_not_absolute/);
  });

  it('refuses credential material (ace#1110 F2) — a description is published, so a read here exfiltrates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-progdesc-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'LABS_MCP_TOKEN=shhh\n');
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: env })).toThrow(PathContainmentError);
    expect(() => resolveOptionalInlineOrPath({ ...ATOM, path: env })).toThrow(/connect_update_program: refusing to touch/);
  });
});

describe('the POST carries the file bytes, and a bad path means no POST at all', () => {
  const EDIT_HTML = `
    <form method="post">
      <input type="hidden" name="csrfmiddlewaretoken" value="tok-1">
      <input name="name" value="Bednet Check Multi-Stage Study — 2026">
      <textarea name="description">stale text from a previous run</textarea>
      <select name="delivery_type"><option value="13" selected>Nutrition</option></select>
      <input name="budget" value="25000">
      <select name="currency"><option value="USD" selected>USD</option></select>
      <select name="country"><option value="IND" selected>IND</option></select>
      <input name="start_date" value="2026-01-01">
      <input name="end_date" value="2026-12-31">
    </form>`;

  function fakeBackend() {
    const posts: Array<{ url: string; form: Record<string, string> }> = [];
    const request = {
      get: vi.fn(async () => ({ status: () => 200, text: async () => EDIT_HTML })),
      post: vi.fn(async (url: string, init: any) => {
        posts.push({ url, form: init.form });
        return { status: () => 302, text: async () => '' };
      }),
    };
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'tok-1',
      request: request as any,
    } as any);
    return { backend, request, posts };
  }

  /** What the atom handler does, in the order it does it. */
  async function callAtom(backend: PlaywrightBackend, args: {
    description?: string; description_path?: string; start_date?: string;
  }) {
    const description = resolveOptionalInlineOrPath({
      ...ATOM, inline: args.description, path: args.description_path,
    });
    return backend.updateProgram({
      organization_slug: 'ai-demo-space',
      program_id: 'efb8af66-fbfd-488f-bf99-66f864cea68b',
      description,
      start_date: args.start_date,
    });
  }

  it('sends the file’s bytes as `description`, unchanged', async () => {
    const { backend, posts } = fakeBackend();
    const p = tmpFile('program-description.md', DESCRIPTION);
    await callAtom(backend, { description_path: p });
    expect(posts).toHaveLength(1);
    expect(posts[0].form.description).toBe(DESCRIPTION);
    expect(posts[0].form.description).toBe(readFileSync(p, 'utf-8'));
  });

  it('is equivalent to the inline call it replaces — same POST body, different transport', async () => {
    const inline = fakeBackend();
    await callAtom(inline.backend, { description: DESCRIPTION });

    const fromFile = fakeBackend();
    await callAtom(fromFile.backend, { description_path: tmpFile('d.md', DESCRIPTION) });

    expect(fromFile.posts[0].form).toEqual(inline.posts[0].form);
  });

  it('leaves the live description alone when neither arg is passed', async () => {
    // A dates-only refresh must keep the program's current text — the
    // backend's `args.description ?? current['description']`.
    const { backend, posts } = fakeBackend();
    await callAtom(backend, { start_date: '2026-02-01' });
    expect(posts[0].form.description).toBe('stale text from a previous run');
    expect(posts[0].form.start_date).toBe('2026-02-01');
  });

  it('makes NO request at all when the path is bad', async () => {
    const { backend, request, posts } = fakeBackend();
    const missing = join(tmpdir(), 'ace-progdesc-nope', 'd.md');
    await expect(callAtom(backend, { description_path: missing })).rejects.toThrow(/unreadable_description_path/);
    expect(posts).toHaveLength(0);
    expect(request.post).not.toHaveBeenCalled();
    // Not even the read half: resolution happens before the client is touched,
    // so a typo cannot cost a session open or an edit-page fetch.
    expect(request.get).not.toHaveBeenCalled();
  });

  it('makes NO request when the file is empty', async () => {
    const { backend, request } = fakeBackend();
    await expect(callAtom(backend, { description_path: tmpFile('d.md', '') }))
      .rejects.toThrow(/empty_description_path/);
    expect(request.post).not.toHaveBeenCalled();
  });
});

describe('registration shape (ace#1448 — a fix that never reaches server.tool is unreachable)', () => {
  const at = serverSrc.indexOf("server.tool('connect_update_program'");
  const src = serverSrc.slice(at, serverSrc.indexOf('server.tool(', at + 10));
  const schema = src.slice(0, src.indexOf('async (args)'));

  it('the extractor found the registration', () => {
    expect(at).toBeGreaterThan(-1);
    expect(schema).toMatch(/organization_slug: z\.string\(\)/);
  });

  it('exposes description_path, this server’s established `<param>_path` spelling', () => {
    // `new_xform_xml_path`, `file_bytes_path` and `ccz_path` are all in this
    // same file. A fourth spelling for the same idea makes the pairing
    // unguessable, which is its own defect.
    expect(schema).toMatch(/^\s{4}description_path: z\.string\(\)\.optional\(\)/m);
    for (const rival of ['description_file', 'descriptionPath', 'localFilePath', 'description_from_path']) {
      expect(schema, `connect_update_program introduced a rival to description_path`).not.toContain(`${rival}:`);
    }
  });

  it('keeps description optional so description_path can stand alone', () => {
    expect(schema).toMatch(/^\s{4}description: z\.string\(\)\.optional\(\)/m);
  });

  it('enforces the contract through the shared resolver, not ad-hoc in the handler', () => {
    expect(src).toMatch(/resolveOptionalInlineOrPath\(\{/);
    expect(src).toMatch(/pathParam: 'description_path'/);
    expect(serverSrc).toMatch(/resolveOptionalInlineOrPath,/);
  });

  it('resolves BEFORE the client, so a bad path costs no session and no HTTP', () => {
    const resolveAt = src.indexOf('resolveOptionalInlineOrPath');
    const clientAt = src.indexOf('await client()');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(clientAt);
  });

  it('hands the resolved text straight to the client — never through a parser', () => {
    // The structural sibling of the byte-fidelity tests above: they would all
    // still pass if the handler round-tripped the description through
    // JSON/YAML or trimmed it, so long as the fixtures happened to survive it.
    const handler = src.slice(src.indexOf('async (args)'));
    expect(handler).toMatch(/updateProgram\(\{ \.\.\.rest, description \}\)/);
    expect(handler).not.toMatch(/description\s*\.\s*(trim|normalize|replace)\(/);
    expect(handler).not.toMatch(/(JSON|YAML|yaml)\.(parse|stringify)/);
  });

  it('the docstring tells a caller why to prefer the path, with the measured number', () => {
    const doc = src.slice(0, schema.indexOf('  {\n'));
    expect(doc).toMatch(/description_path/);
    expect(doc).toMatch(/21,012/);
    expect(doc).toMatch(/ace#2291/);
  });
});
