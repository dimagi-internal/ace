#!/usr/bin/env npx tsx
import { parseDecisionsYaml, serializeDecisionsLog } from "../lib/decisions-schema.js";
import { parseDocumentStructure } from "../lib/decisions-parser.js";
import { mergeDecisions, type ChangeReport } from "../lib/decisions-sync.js";

export interface DecisionsSyncDriveClient {
  findFile(args: { parentFolderId: string; name: string }): Promise<{ id: string } | null>;
  getDoc(documentId: string): Promise<unknown>;
  readFile(args: { parentFolderId: string; name: string }): Promise<{ content: string }>;
  writeFile(args: { parentFolderId: string; name: string; content: string }): Promise<void>;
}

export interface RunDecisionsSyncArgs {
  runFolderFileId: string;
  driveClient: DecisionsSyncDriveClient;
}

export interface RunDecisionsSyncResult {
  gdocId: string;
  report: ChangeReport;
}

export async function runDecisionsSync(
  args: RunDecisionsSyncArgs,
): Promise<RunDecisionsSyncResult> {
  const { runFolderFileId, driveClient } = args;

  const gdocFile = await driveClient.findFile({
    parentFolderId: runFolderFileId,
    name: "decisions.gdoc",
  });
  if (!gdocFile) {
    throw new Error(
      `decisions.gdoc not found in run folder ${runFolderFileId}. Run /ace:step decisions-render first to produce the gdoc.`,
    );
  }

  const doc = await driveClient.getDoc(gdocFile.id);
  const parsedRows = parseDocumentStructure(doc as Parameters<typeof parseDocumentStructure>[0]);

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

  const currentLog = parseDecisionsYaml(yamlContent);
  const { merged, report } = mergeDecisions(parsedRows, currentLog);

  // Bump generated_at on every sync write.
  merged.generated_at = new Date().toISOString();

  const newYaml = serializeDecisionsLog(merged);
  await driveClient.writeFile({
    parentFolderId: runFolderFileId,
    name: "decisions.yaml",
    content: newYaml,
  });

  return { gdocId: gdocFile.id, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("Direct CLI mode not yet wired — invoke via /ace:step decisions-sync <opp>/<run-id> instead.");
  process.exit(2);
}
