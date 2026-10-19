#!/usr/bin/env npx tsx
/**
 * Write a markdown file into one TAB of an existing Google Doc, as ACE's
 * service account.
 *
 *   npx tsx scripts/gdoc-tab.ts --doc <docId> --md <file.md> --title "Overview" \
 *     [--index 0] [--rename-tab "<old title>=<new title>"] [--key <sa.json>]
 *
 * If a tab titled --title already exists it is deleted and re-added at the
 * same position, so a re-run replaces the tab in place (same doc, same link,
 * other tabs untouched). --index sets the position of a new tab (0 = first).
 * --rename-tab renames another tab in the same call (e.g. the doc's original
 * first tab to "Review details").
 *
 * Content rules (headings, bullets, bold, links; no pipe tables) are those of
 * lib/markdown-docs-tab.ts. Prints {documentId, tabId, title, url} as JSON.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { markdownToTabRequests } from '../lib/markdown-docs-tab.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

loadPluginEnv(import.meta.url);

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function keyFile(): string {
  const cli = arg('key');
  if (cli && fs.existsSync(cli)) return cli;
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const data = resolvePluginDataDir(import.meta.url);
  const p = data ? path.join(data, 'gws-sa-key.json') : '';
  if (p && fs.existsSync(p)) return p;
  const conventional = path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json');
  if (fs.existsSync(conventional)) return conventional;
  throw new Error('no Drive service-account key (gws-sa-key.json) — run /ace:setup or pass --key');
}

interface TabInfo {
  tabId: string;
  title: string;
  index: number;
}

async function main(): Promise<number> {
  const documentId = arg('doc');
  const mdPath = arg('md');
  const title = arg('title');
  if (!documentId || !mdPath || !title) {
    process.stderr.write('gdoc-tab: --doc, --md and --title are required\n');
    return 2;
  }
  const markdown = fs.readFileSync(mdPath, 'utf8');
  // Fail on unsupported markdown before touching the doc.
  markdownToTabRequests(markdown, 'probe');

  const auth = new google.auth.GoogleAuth({ keyFile: keyFile(), scopes: ['https://www.googleapis.com/auth/documents'] });
  const docs = google.docs({ version: 'v1', auth });

  const readTabs = async (): Promise<TabInfo[]> => {
    const doc = await docs.documents.get({ documentId, includeTabsContent: true });
    return (doc.data.tabs ?? []).map((t, i) => ({
      tabId: t.tabProperties?.tabId ?? '',
      title: t.tabProperties?.title ?? '',
      index: t.tabProperties?.index ?? i,
    }));
  };

  let tabs = await readTabs();
  const pre: object[] = [];
  const existing = tabs.find((t) => t.title === title);
  let index = arg('index') !== undefined ? Number(arg('index')) : tabs.length;
  if (existing) {
    index = existing.index;
    pre.push({ deleteTab: { tabId: existing.tabId } });
  }
  const rename = arg('rename-tab');
  if (rename) {
    const [from, to] = rename.split('=');
    const t = tabs.find((x) => x.title === from);
    if (t) pre.push({ updateDocumentTabProperties: { tabProperties: { tabId: t.tabId, title: to }, fields: 'title' } });
    else if (!tabs.some((x) => x.title === to)) throw new Error(`--rename-tab: no tab titled "${from}" (tabs: ${tabs.map((x) => x.title).join(', ')})`);
  }
  pre.push({ addDocumentTab: { tabProperties: { title, index } } });

  const added = await docs.documents.batchUpdate({ documentId, requestBody: { requests: pre } });
  const reply = (added.data.replies ?? []).find((r: any) => r.addDocumentTab) as any;
  const tabId: string | undefined = reply?.addDocumentTab?.tabProperties?.tabId;
  if (!tabId) throw new Error('addDocumentTab returned no tabId');

  await docs.documents.batchUpdate({ documentId, requestBody: { requests: markdownToTabRequests(markdown, tabId) as object[] } });

  tabs = await readTabs();
  if (!tabs.some((t) => t.tabId === tabId && t.title === title)) throw new Error('tab not found on read-back');
  process.stdout.write(
    JSON.stringify({ documentId, tabId, title, tabs: tabs.map((t) => t.title), url: `https://docs.google.com/document/d/${documentId}/edit?tab=${tabId}` }) + '\n',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`gdoc-tab: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
