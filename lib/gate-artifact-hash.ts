/**
 * Every grade records the hash of what it graded (`artifact_sha256`) — stamped
 * ONCE, in the shared write path, not by each of the ~50 QA/eval skills.
 *
 * Why (ace#3092 item 1): `validate-release-readiness` decides a gate is stale
 * when its artifact changed after it. By timestamp alone, any later write to
 * the artifact — a clone's id rewrite, a readiness link repair, a re-save of
 * identical bytes — re-opens the gate and asks for a re-grade. A grade that
 * carries `artifact_sha256 = contentSha(<graded artifact>)` stays fresh while
 * the content still matches (`lib/release-readiness.ts` `isStale`), directly or
 * through the content ledger's hash chain. Nothing wrote it, so the honoured
 * field never helped a normal run.
 *
 * Where: ace-gdrive's three write atoms (`drive_create_file`,
 * `drive_update_file`, `drive_upload_binary`) already route every
 * `*-qa_result*.yaml` / `*_verdict*.yaml` through the write guards — that is the
 * one place every grade passes. There, before the write, this reads the file
 * the grade names in `capture_path` (run-relative — the same path readiness
 * resolves with `capturedArtifact`), exactly as readiness's inventory reads it
 * (a Google Doc exported as text/plain, anything else its media), and appends
 * `artifact_sha256`. Skills change nothing.
 *
 * Best effort by construction: a grade whose `capture_path` does not resolve
 * to one run file (a `.gdoc` alias, "a.md + b.md", a local path), an unreadable
 * artifact, or any Drive error leaves the grade exactly as written — readiness
 * then judges it by timestamp, as before. A grade that already carries the
 * field is never touched: the grader's own hash wins.
 */
import { parse as parseYaml } from 'yaml';
import { contentSha } from './release-readiness.js';

/** QA results and eval verdicts — the files readiness treats as gates. */
export const GATE_FILE = /(-qa_result(?:-[a-z0-9]+)?|_verdict(?:-[a-z0-9]+)?)\.ya?ml$/i;

/** The Drive reads the stamp needs — injectable, so the logic is testable without Drive. */
export interface RunTreeReader {
  /** A folder's name and parents. */
  folder(id: string): Promise<{ name: string; parents: string[] }>;
  /** The one non-trashed child named `name` (null when none; throws on several). */
  child(parentId: string, name: string): Promise<{ id: string; mimeType: string } | null>;
  /** The file's text as readiness's inventory reads it. */
  readText(id: string, mimeType: string): Promise<string>;
}

export type StampResult =
  | { text: string; stamped: string; artifact: string }
  | { text: string; stamped?: undefined; skipped: string };

/** A run-relative capture path readiness can resolve, as segments; null otherwise. */
export function captureSegments(capturePath: unknown): string[] | null {
  if (typeof capturePath !== 'string') return null;
  const p = capturePath.trim().replace(/^\/+/, '');
  // Readiness matches the path exactly (`capturedArtifact`); anything that is
  // not one plain run path cannot be its artifact.
  if (!p || /\s\+\s|[\n,]/.test(p) || p.startsWith('runs/') || p.includes('..')) return null;
  const segs = p.split('/').filter(Boolean);
  return segs.length ? segs : null;
}

/**
 * The run folder for a gate written into `parentFolderId`: gates live in a
 * phase folder (`1-design`, `3-commcare`, …) directly under the run, so the
 * run is the parent's parent; a gate written straight into the run folder has
 * it as its parent.
 */
async function runFolderOf(parentFolderId: string, reader: RunTreeReader): Promise<string | null> {
  const p = await reader.folder(parentFolderId);
  if (!/^\d+-[a-z]/i.test(p.name)) return parentFolderId;
  return p.parents[0] ?? null;
}

/**
 * Append `artifact_sha256` to a gate file's YAML text, or return it unchanged
 * with the reason. Never throws.
 */
export async function stampGateArtifactSha(
  name: string,
  text: string,
  parentFolderId: string | null | undefined,
  reader: RunTreeReader,
): Promise<StampResult> {
  try {
    if (!GATE_FILE.test(name ?? '')) return { text, skipped: 'not a gate file' };
    if (!parentFolderId) return { text, skipped: 'no parent folder' };
    const data = parseYaml(String(text).replace(/\r\n/g, '\n')) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { text, skipped: 'not a YAML mapping' };
    if (typeof data.artifact_sha256 === 'string' && data.artifact_sha256) return { text, skipped: 'already carries artifact_sha256' };
    const segs = captureSegments(data.capture_path);
    if (!segs) return { text, skipped: `capture_path ${JSON.stringify(data.capture_path)} is not one run path` };
    let at = await runFolderOf(parentFolderId, reader);
    let hit: { id: string; mimeType: string } | null = null;
    for (const seg of segs) {
      if (!at) break;
      hit = await reader.child(at, seg);
      at = hit?.id ?? null;
    }
    if (!hit || !at) return { text, skipped: `capture_path ${segs.join('/')} not found in the run` };
    if (hit.mimeType === 'application/vnd.google-apps.folder') return { text, skipped: 'capture_path is a folder' };
    if (/^(image|video|audio)\//.test(hit.mimeType)) return { text, skipped: 'capture_path is media' };
    const hash = contentSha(await reader.readText(hit.id, hit.mimeType));
    const line = `artifact_sha256: ${hash}\n`;
    const stamped = text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`;
    // Appending a top-level key must change nothing else (a trailing block
    // scalar, a flow mapping, a `...` end marker could swallow it): re-parse.
    const back = parseYaml(stamped.replace(/\r\n/g, '\n')) as Record<string, unknown> | null;
    if (!back || back.artifact_sha256 !== hash) return { text, skipped: 'could not append the field safely' };
    const { artifact_sha256: _drop, ...rest } = back;
    if (JSON.stringify(rest) !== JSON.stringify(data)) return { text, skipped: 'could not append the field safely' };
    return { text: stamped, stamped: hash, artifact: segs.join('/') };
  } catch (e) {
    return { text, skipped: `error: ${(e as Error).message}`.slice(0, 200) };
  }
}

/** A `RunTreeReader` over the googleapis Drive v3 client the MCP server already holds. */
export function googleRunTreeReader(drive: any): RunTreeReader {
  return {
    async folder(id) {
      const r = await drive.files.get({ fileId: id, fields: 'name, parents', supportsAllDrives: true });
      return { name: String(r.data.name ?? ''), parents: (r.data.parents ?? []) as string[] };
    },
    async child(parentId, name) {
      const q = `'${parentId}' in parents and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
      const r = await drive.files.list({ q, fields: 'files(id, mimeType)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 2 });
      const files = (r.data.files ?? []) as Array<{ id: string; mimeType: string }>;
      if (files.length > 1) throw new Error(`two files named ${name}`);
      return files[0] ? { id: files[0].id, mimeType: files[0].mimeType } : null;
    },
    async readText(id, mimeType) {
      const res =
        mimeType === 'application/vnd.google-apps.document'
          ? await drive.files.export({ fileId: id, mimeType: 'text/plain' }, { responseType: 'text' })
          : await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
      return String(res.data).replace(/^﻿/, '');
    },
  };
}
