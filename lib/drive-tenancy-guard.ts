/**
 * Drive half of the tenancy guard: a session bound to an opp (bin/ace-bind)
 * may only WRITE inside that opp's Drive folder.
 *
 * hooks/tenancy_guard.py checks HQ / Connect / OCS / Labs writes from the
 * tool arguments alone. Drive cannot be checked that way — "is this file id
 * inside the opp's folder?" needs an authenticated walk up the parent chain —
 * and the hook is stdlib-only, so the Drive check lives here, installed on the
 * ace-gdrive and ace-decisions servers the way `installToolErrorGuard` wraps
 * ace-mobile's callbacks. MCP servers inherit `CLAUDE_CODE_SESSION_ID`, which
 * keys the same bind file the hook reads.
 *
 * Same semantics as the hook:
 *  - unbound session → allowed (rollout);
 *  - bound, mode "warn" → allowed, recorded in bound-violations.log;
 *  - bound, mode "enforce" → refused with a tool error naming the opp.
 * Reads are never checked: copying FROM a shared template into the opp is the
 * normal path, so only the destination argument of a copy is checked.
 *
 * It stops mistakes, not a compromised session (the agent can edit the bind
 * file). Spec: ace-web docs/specs/2026-09-28-clone-and-release-design.md § D.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Write tools → the argument(s) naming what they write into. */
export const DRIVE_WRITE_TARGETS: Record<string, readonly string[]> = {
  drive_create_file: ['parentFolderId'],
  drive_create_doc_from_markdown: ['parentFolderId'],
  drive_copy_file: ['parentFolderId'],
  drive_upload_binary: ['parentFolderId'],
  drive_create_folder: ['parentFolderId'],
  drive_create_shortcut: ['parentFolderId'],
  drive_move_file: ['fileId', 'newParentFolderId'],
  slides_copy_template: ['parentFolderId'],
  docs_copy_template: ['parentFolderId'],
  render_run_readme: ['runFolderFileId'],
  render_decisions_log: ['runFolderFileId'],
  verify_phase_artifacts: ['runFolderId'],
  drive_update_file: ['fileId'],
  update_yaml_file: ['fileId'],
  drive_rename_file: ['fileId'],
  drive_trash_file: ['fileId'],
  drive_set_anyone_with_link: ['fileId'],
  drive_share_with_person: ['fileId'],
  drive_transfer_ownership: ['fileId'],
  drive_reply_to_comment: ['fileId'],
  sheets_write: ['spreadsheetId'],
  sheets_append: ['spreadsheetId'],
  sheets_create_tab: ['spreadsheetId'],
  docs_batch_update: ['documentId'],
  docs_insert_email_blocks: ['documentId'],
  docs_finalize_bullets: ['documentId'],
  docs_finalize_bold: ['documentId'],
  slides_batch_update: ['presentationId'],
  decisions_append_rows: ['runFolderId'],
};

/**
 * Tools whose destination is OPTIONAL but, when omitted, lands OUTSIDE the
 * opp (docs_copy_template drops the copy next to the template). In a bound
 * session the destination must be given.
 */
export const DESTINATION_REQUIRED_WHEN_BOUND: ReadonlySet<string> = new Set(['docs_copy_template']);

export interface OppBinding {
  workspace: string;
  opp: string;
  mode?: 'enforce' | 'warn';
  drive_root_folder_id?: string;
}

export function bindDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACE_OPP_BIND_DIR || path.join(os.homedir(), '.ace', 'opp-bind');
}

export function readBinding(env: NodeJS.ProcessEnv = process.env): OppBinding | null {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session) return null;
  const file = path.join(bindDir(env), `${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? (data as OppBinding) : null;
  } catch {
    return null;
  }
}

export interface DriveLookup {
  /** Parent folder ids of a file or folder ([] for a Shared Drive root). */
  parents(id: string): Promise<string[]>;
  /** Id of the child FOLDER named `name` under `parentId`, or null. */
  childFolder(parentId: string, name: string): Promise<string | null>;
}

const MAX_HOPS = 15;

/** True iff `id` is the opp folder or anywhere beneath it. */
export async function isInside(lookup: DriveLookup, id: string, oppFolderId: string): Promise<boolean> {
  let frontier = [id];
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_HOPS && frontier.length; hop++) {
    if (frontier.includes(oppFolderId)) return true;
    const next: string[] = [];
    for (const f of frontier) {
      if (seen.has(f)) continue;
      seen.add(f);
      next.push(...(await lookup.parents(f)));
    }
    frontier = next;
  }
  return false;
}

export interface GuardDecision {
  allow: boolean;
  problems: string[];
}

/** Decide one call. Pure except for the injected Drive lookup. */
export async function checkDriveWrite(
  tool: string,
  args: Record<string, unknown>,
  binding: OppBinding | null,
  lookup: DriveLookup,
): Promise<GuardDecision> {
  const targets = DRIVE_WRITE_TARGETS[tool];
  if (!targets || !binding) return { allow: true, problems: [] };
  if (!binding.drive_root_folder_id) {
    // An older bind file: nothing to check against. Re-binding records it.
    return { allow: true, problems: [] };
  }
  const oppFolder = await lookup.childFolder(binding.drive_root_folder_id, binding.opp);
  if (!oppFolder) {
    return {
      allow: false,
      problems: [`the bound opp's folder ${binding.opp}/ was not found under the workspace Drive root`],
    };
  }
  const problems: string[] = [];
  let checked = 0;
  for (const arg of targets) {
    const value = args[arg];
    if (typeof value !== 'string' || !value) continue;
    checked++;
    if (!(await isInside(lookup, value, oppFolder))) {
      problems.push(`\`${arg}\` = ${value} is not inside the opp's folder ${binding.opp}/`);
    }
  }
  if (checked === 0 && DESTINATION_REQUIRED_WHEN_BOUND.has(tool)) {
    problems.push(`${tool} needs \`${targets[0]}\` in a bound session — without it the copy lands outside the opp`);
  }
  return { allow: problems.length === 0, problems };
}

function logViolation(tool: string, args: unknown, binding: OppBinding, problems: string[]): void {
  try {
    const dir = bindDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      session_id: process.env.CLAUDE_CODE_SESSION_ID,
      tool,
      input: args,
      opp: `${binding.workspace}/${binding.opp}`,
      problems,
    });
    fs.appendFileSync(path.join(dir, 'bound-violations.log'), line.slice(0, 4000) + '\n');
  } catch {
    // Logging must never break a tool call.
  }
}

type AnyToolCallback = (...args: unknown[]) => unknown;
interface GuardableServer {
  tool?: AnyToolCallback;
  registerTool?: AnyToolCallback;
}

/**
 * Wrap every write tool registered AFTER this call. MUST run before the first
 * registration (test/mcp/drive-tenancy-guard.test.ts asserts the ordering).
 */
export function installDriveTenancyGuard(server: GuardableServer, lookup: DriveLookup): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method];
    if (typeof original !== 'function') continue;
    const bound = original.bind(server) as AnyToolCallback;
    server[method] = ((...regArgs: unknown[]) => {
      const name = regArgs[0];
      const last = regArgs[regArgs.length - 1];
      if (typeof name === 'string' && DRIVE_WRITE_TARGETS[name] && typeof last === 'function') {
        const handler = last as AnyToolCallback;
        regArgs[regArgs.length - 1] = async (...callArgs: unknown[]) => {
          const toolArgs = (callArgs[0] ?? {}) as Record<string, unknown>;
          const binding = readBinding();
          let decision: GuardDecision;
          try {
            decision = await checkDriveWrite(name, toolArgs, binding, lookup);
          } catch (err) {
            // A Drive hiccup in the CHECK must not become a refusal of real work.
            decision = { allow: true, problems: [] };
            void err;
          }
          if (!decision.allow && binding) {
            if (binding.mode === 'warn') {
              logViolation(name, toolArgs, binding, decision.problems);
            } else {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text:
                      `BLOCKED by the tenancy guard: this session is bound to opp ` +
                      `${binding.workspace}/${binding.opp}, and ${name} would write outside its Drive folder.\n` +
                      decision.problems.map((p) => `  - ${p}`).join('\n') +
                      `\nIf this is for a different opp, bind to it first (bin/ace-bind <workspace>/<opp>). ` +
                      `Do not work around this guard.`,
                  },
                ],
              };
            }
          }
          return handler(...callArgs);
        };
      }
      return bound(...regArgs);
    }) as AnyToolCallback;
  }
}

/** A DriveLookup over the googleapis Drive v3 client, with a short cache. */
export function googleDriveLookup(drive: {
  files: {
    get(p: Record<string, unknown>): Promise<{ data: { parents?: string[] | null } }>;
    list(p: Record<string, unknown>): Promise<{ data: { files?: Array<{ id?: string | null }> | null } }>;
  };
}): DriveLookup {
  const parentsCache = new Map<string, { at: number; value: string[] }>();
  const TTL_MS = 60_000;
  return {
    async parents(id) {
      const hit = parentsCache.get(id);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
      const res = await drive.files.get({ fileId: id, fields: 'parents', supportsAllDrives: true });
      const value = res.data.parents ?? [];
      parentsCache.set(id, { at: Date.now(), value });
      return value;
    },
    async childFolder(parentId, name) {
      const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const res = await drive.files.list({
        q: `'${parentId}' in parents and name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 2,
      });
      return res.data.files?.[0]?.id ?? null;
    },
  };
}
