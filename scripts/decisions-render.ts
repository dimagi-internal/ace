#!/usr/bin/env npx tsx
import { parseDecisionsYaml } from "../lib/decisions-schema.js";
import { renderDecisionsLog } from "../lib/decisions-renderer.js";

/**
 * Drive client interface — subset of ace-gdrive operations needed by
 * the renderer runner. Production callers pass a wrapper around the
 * MCP atoms; tests pass a mock.
 */
export interface DecisionsRenderDriveClient {
  readFile(args: { parentFolderId: string; name: string }): Promise<{ content: string }>;
  findOrCreateDoc(args: { parentFolderId: string; name: string }): Promise<{ id: string; reused: boolean }>;
  clearDocBody(docId: string): Promise<void>;
  batchUpdateDoc(args: { documentId: string; requests: unknown[] }): Promise<{ replies: unknown[] }>;
}

export interface RunDecisionsRenderArgs {
  runFolderFileId: string;
  driveClient: DecisionsRenderDriveClient;
}

export interface RunDecisionsRenderResult {
  gdocId: string;
  reused: boolean;
  requestCount: number;
}

/**
 * Read decisions.yaml from a run folder, render it, and apply the
 * rendered requests to the per-run decisions.gdoc. Idempotent: the
 * gdoc lives at one stable URL per run; existing content is cleared
 * before the new render is applied.
 */
export async function runDecisionsRender(
  args: RunDecisionsRenderArgs,
): Promise<RunDecisionsRenderResult> {
  const { runFolderFileId, driveClient } = args;

  let yamlContent: string;
  try {
    const file = await driveClient.readFile({
      parentFolderId: runFolderFileId,
      name: "decisions.yaml",
    });
    yamlContent = file.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `decisions.yaml not found in run folder ${runFolderFileId}: ${msg}`,
    );
  }

  const log = parseDecisionsYaml(yamlContent);
  const requests = renderDecisionsLog(log);

  const gdoc = await driveClient.findOrCreateDoc({
    parentFolderId: runFolderFileId,
    name: "decisions.gdoc",
  });

  await driveClient.clearDocBody(gdoc.id);
  await driveClient.batchUpdateDoc({
    documentId: gdoc.id,
    requests,
  });

  return {
    gdocId: gdoc.id,
    reused: gdoc.reused,
    requestCount: requests.length,
  };
}

// CLI entry point — only when invoked directly as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx scripts/decisions-render.ts <run-folder-fileId>");
    process.exit(1);
  }
  // Direct CLI mode is intentionally not wired: it would require a live
  // Drive client bound to the ace-gdrive MCP, which only exists inside a
  // Claude Code session. The canonical agent path drives the render
  // through the ace-gdrive atoms directly (drive_read_file +
  // drive_create_doc_from_markdown with findOrCreate) — see
  // skills/decisions-render/SKILL.md § Process Step 2. The
  // `renderDecisionsToDoc` / `renderDecisionsLog` functions above remain
  // importable for tests and any future wiring. Standalone phase agents
  // (e.g. idea-to-design) use the same MCP-atom path; they do not shell
  // out to this script.
  console.error(
    "scripts/decisions-render.ts has no standalone CLI: render via the " +
      "ace-gdrive atoms (drive_read_file + drive_create_doc_from_markdown) " +
      "as documented in skills/decisions-render/SKILL.md § Process Step 2, " +
      "or /ace:step decisions-render <opp>/<run-id>.",
  );
  process.exit(2);
}
