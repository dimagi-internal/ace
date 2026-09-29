/**
 * Drive half of the tenancy guard (lib/drive-tenancy-guard.ts): a session bound
 * to an opp may only write inside that opp's Drive folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DRIVE_WRITE_TARGETS,
  checkDriveWrite,
  installDriveTenancyGuard,
  isInside,
  type DriveLookup,
  type OppBinding,
} from '../../lib/drive-tenancy-guard';

// The canonical ACE opp layout (fixture) and a real bin/ace-bind output.
const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'drive-tenancy');
const TREE = JSON.parse(fs.readFileSync(path.join(FIX, 'opp-tree.json'), 'utf8'));
const PARENTS = TREE.parents as Record<string, string[]>;
const FOLDERS = TREE.folders_by_parent as Record<string, Record<string, string>>;
const lookup: DriveLookup = {
  async parents(id) {
    return PARENTS[id] ?? [];
  },
  async childFolder(parentId, name) {
    return FOLDERS[parentId]?.[name] ?? null;
  },
};
const BOUND: OppBinding = JSON.parse(fs.readFileSync(path.join(FIX, 'bind-file.json'), 'utf8')).binding;

describe('isInside', () => {
  it('walks up the parent chain from a deep artifact', async () => {
    expect(await isInside(lookup, 'training-flw-guide.md', 'spark-facilitator')).toBe(true);
    expect(await isInside(lookup, 'spark-facilitator', 'spark-facilitator')).toBe(true);
    expect(await isInside(lookup, 'other-opp/run_state.yaml', 'spark-facilitator')).toBe(false);
  });
});

describe('checkDriveWrite', () => {
  it('allows everything in an unbound session', async () => {
    const r = await checkDriveWrite('drive_update_file', { fileId: 'other-opp/run_state.yaml' }, null, lookup);
    expect(r.problems).toEqual([]);
  });

  it('passes a clean write inside the bound opp', async () => {
    const r = await checkDriveWrite('update_yaml_file', { fileId: 'run_state.yaml' }, BOUND, lookup);
    expect(r.problems).toEqual([]);
    expect(r.allow).toBe(true);
  });

  it('refuses a write into another opp', async () => {
    const r = await checkDriveWrite('drive_update_file', { fileId: 'other-opp/run_state.yaml' }, BOUND, lookup);
    expect(r.allow).toBe(false);
    expect(r.problems[0]).toContain('fileId');
  });

  it('checks only the destination of a copy, so shared templates stay readable', async () => {
    const ok = await checkDriveWrite(
      'slides_copy_template',
      { templatePresentationId: 'training-deck-template', parentFolderId: '6-qa-and-training' },
      BOUND,
      lookup,
    );
    expect(ok.problems).toEqual([]);
    const bad = await checkDriveWrite('drive_copy_file', { sourceFileId: 'opp.yaml', parentFolderId: 'other-opp' }, BOUND, lookup);
    expect(bad.problems).toHaveLength(1);
  });

  it('checks both ends of a move', async () => {
    const ok = await checkDriveWrite('drive_move_file', { fileId: 'decisions.yaml', newParentFolderId: 'inputs' }, BOUND, lookup);
    expect(ok.problems).toEqual([]);
    const bad = await checkDriveWrite(
      'drive_move_file',
      { fileId: 'other-opp/run_state.yaml', newParentFolderId: 'inputs' },
      BOUND,
      lookup,
    );
    expect(bad.problems).toHaveLength(1);
  });

  it('requires docs_copy_template to name a destination when bound', async () => {
    const r = await checkDriveWrite('docs_copy_template', { templateDocId: 'training-deck-template' }, BOUND, lookup);
    expect(r.problems[0]).toContain('parentFolderId');
  });

  it('ignores read tools and older bind files without a Drive root', async () => {
    const read = await checkDriveWrite('drive_read_file', { fileId: 'other-opp/run_state.yaml' }, BOUND, lookup);
    expect(read.problems).toEqual([]);
    const { drive_root_folder_id: _unused, ...old } = BOUND;
    const r = await checkDriveWrite('drive_update_file', { fileId: 'other-opp/run_state.yaml' }, old, lookup);
    expect(r.problems).toEqual([]);
  });

  it('refuses when the bound opp folder does not exist', async () => {
    const r = await checkDriveWrite('drive_update_file', { fileId: 'opp.yaml' }, { ...BOUND, opp: 'missing' }, lookup);
    expect(r.problems).toHaveLength(1);
  });
});

describe('installDriveTenancyGuard', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-guard-'));
    process.env.ACE_OPP_BIND_DIR = dir;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  function serverWith(mode: 'enforce' | 'warn') {
    fs.writeFileSync(path.join(dir, 'sess-1.json'), JSON.stringify({ ...BOUND, mode }));
    const registered: Record<string, (...a: unknown[]) => unknown> = {};
    const server = {
      tool: (...args: unknown[]) => {
        registered[args[0] as string] = args[args.length - 1] as (...a: unknown[]) => unknown;
      },
    };
    installDriveTenancyGuard(server, lookup);
    server.tool('drive_update_file', {}, async () => ({ content: [{ type: 'text', text: 'wrote' }] }));
    server.tool('drive_read_file', {}, async () => ({ content: [{ type: 'text', text: 'read' }] }));
    return registered;
  }

  it('refuses in enforce mode without calling the handler', async () => {
    const tools = serverWith('enforce');
    const r = (await tools.drive_update_file({ fileId: 'other-opp/run_state.yaml' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('spark/spark-facilitator');
  });

  it('lets the call through in warn mode and records it', async () => {
    const tools = serverWith('warn');
    const r = (await tools.drive_update_file({ fileId: 'other-opp/run_state.yaml' })) as { content: { text: string }[] };
    expect(r.content[0].text).toBe('wrote');
    expect(fs.readFileSync(path.join(dir, 'bound-violations.log'), 'utf8')).toContain('drive_update_file');
  });

  it('never wraps read tools', async () => {
    const tools = serverWith('enforce');
    const r = (await tools.drive_read_file({ fileId: 'other-opp/run_state.yaml' })) as { content: { text: string }[] };
    expect(r.content[0].text).toBe('read');
  });
});

describe('installation', () => {
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  for (const file of ['mcp/google-drive-server.ts', 'mcp/decisions-server.ts']) {
    it(`${file} installs the guard before its first tool registration`, () => {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      const install = src.indexOf('installDriveTenancyGuard(server');
      const firstTool = src.search(/\bserver\.(tool|registerTool)\(/);
      expect(install).toBeGreaterThan(-1);
      expect(install).toBeLessThan(firstTool);
    });
  }

  it('every guarded tool exists on one of those servers', () => {
    const src =
      fs.readFileSync(path.join(REPO, 'mcp/google-drive-server.ts'), 'utf8') +
      fs.readFileSync(path.join(REPO, 'mcp/decisions-server.ts'), 'utf8');
    for (const tool of Object.keys(DRIVE_WRITE_TARGETS)) {
      expect(src, tool).toContain(`'${tool}'`);
    }
  });
});
