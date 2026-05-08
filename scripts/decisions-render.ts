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
  // CLI mode requires a real Drive client wired to the ace-gdrive MCP.
  // The skill body (skills/decisions-render/SKILL.md, Task 5) wires
  // those atoms into a DecisionsRenderDriveClient at invocation time.
  // Direct CLI mode is not yet wired — invoke via the skill instead.
  console.error(
    "Direct CLI mode not yet wired — invoke via /ace:step decisions-render <opp>/<run-id> instead.",
  );
  process.exit(2);
}
