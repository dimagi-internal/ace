import { describe, expect, it, vi } from "vitest";
import { runDecisionsSync } from "../../../scripts/decisions-sync.js";

const VALID_YAML = `schema_version: 3
opportunity: turmeric
run_id: 20260507-1733
generated_at: "2026-05-07T17:33:00Z"
decisions:
  - id: flw-count
    phase: 1-design
    skill: idea-to-pdd
    question: How many FLWs?
    ai-default: "5–8"
    options: ["3–5", "5–8", "10–15"]
    source: idea.md §2
    status: ai-default
`;

const FAKE_GDOC = {
  body: {
    content: [
      {
        paragraph: {
          elements: [{ textRun: { content: "flw-count\n" } }],
          paragraphStyle: { namedStyleType: "HEADING_3" },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: "  AI-default: 5–8\n" } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: "  Override: 12\n" } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      },
    ],
  },
};

function makeFakeDriveClient() {
  return {
    findFile: vi.fn(),
    getDoc: vi.fn().mockResolvedValue(FAKE_GDOC),
    readFile: vi.fn().mockResolvedValue({ content: VALID_YAML }),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runDecisionsSync", () => {
  it("reads gdoc + yaml, merges, writes updated yaml, returns the change report", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce({ id: "fake-gdoc-id" });

    const result = await runDecisionsSync({
      runFolderFileId: "fake-folder-id",
      driveClient: client,
    });

    expect(client.findFile).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.gdoc",
    });
    expect(client.getDoc).toHaveBeenCalledWith("fake-gdoc-id");
    expect(client.readFile).toHaveBeenCalledWith({
      parentFolderId: "fake-folder-id",
      name: "decisions.yaml",
    });
    expect(client.writeFile).toHaveBeenCalled();

    const writeArgs = client.writeFile.mock.calls[0]![0];
    expect(writeArgs.parentFolderId).toBe("fake-folder-id");
    expect(writeArgs.name).toBe("decisions.yaml");
    expect(writeArgs.content).toContain("override: \"12\"");
    expect(writeArgs.content).toContain("status: overridden");
    // ai-default is preserved (not destroyed by override)
    expect(writeArgs.content).toContain("ai-default:");

    expect(result.report.defaultsOverridden).toEqual([
      { id: "flw-count", from: "5–8", to: "12" },
    ]);
  });

  it("throws an actionable error when decisions.gdoc is missing", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce(null);

    await expect(
      runDecisionsSync({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.gdoc/);
  });

  it("throws an actionable error when decisions.yaml is missing", async () => {
    const client = makeFakeDriveClient();
    client.findFile.mockResolvedValueOnce({ id: "fake-gdoc-id" });
    client.readFile.mockRejectedValueOnce(new Error("File not found"));

    await expect(
      runDecisionsSync({ runFolderFileId: "fake-folder-id", driveClient: client }),
    ).rejects.toThrow(/decisions\.yaml/);
  });
});
