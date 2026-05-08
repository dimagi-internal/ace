import { describe, expect, it, vi } from "vitest";
import { runDecisionsRender } from "../../../scripts/decisions-render.js";

function makeFakeDriveClient() {
  return {
    readFile: vi.fn().mockResolvedValue({ content: "" }),
    findOrCreateDoc: vi.fn().mockResolvedValue({ id: "fake-gdoc-id", reused: false }),
    batchUpdateDoc: vi.fn().mockResolvedValue({ replies: [] }),
    clearDocBody: vi.fn().mockResolvedValue(undefined),
  };
}

const VALID_YAML = `schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: archetype-selection
    phase: 1-design
    skill: idea-to-pdd
    question: Which delivery archetype?
    default: atomic-visit
    options_considered: ["atomic-visit", "focus-group", "multi-stage"]
    source: idea.md §1
    status: applied
`;

describe("runDecisionsRender", () => {
  it("reads the YAML, finds-or-creates the gdoc, clears it, and applies the rendered requests", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockResolvedValueOnce({ content: VALID_YAML });

    const result = await runDecisionsRender({
      runFolderFileId: "fake-folder-id",
      driveClient: client,
    });

    expect(client.readFile).toHaveBeenCalled();
    expect(client.findOrCreateDoc).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.gdoc",
    });
    expect(client.clearDocBody).toHaveBeenCalledWith("fake-gdoc-id");
    expect(client.batchUpdateDoc).toHaveBeenCalled();
    const callArgs = client.batchUpdateDoc.mock.calls[0]![0];
    expect(callArgs.documentId).toBe("fake-gdoc-id");
    expect(callArgs.requests.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ gdocId: "fake-gdoc-id" });
  });

  it("throws an actionable error when decisions.yaml is missing from the run folder", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockRejectedValueOnce(new Error("File not found"));

    await expect(
      runDecisionsRender({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.yaml/);
  });

  it("throws on schema-invalid YAML with the schema dot-path", async () => {
    const client = makeFakeDriveClient();
    client.readFile.mockResolvedValueOnce({
      content: `schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: ""
    phase: 1-design
    skill: idea-to-pdd
    question: Q
    default: x
    options_considered: []
    source: x
    status: applied
`,
    });

    await expect(
      runDecisionsRender({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.0\.id/);
  });
});
