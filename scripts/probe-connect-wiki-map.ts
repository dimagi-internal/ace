/**
 * Probe: do the pages in `templates/training-deck/_common/connect-wiki-map.yaml`
 * still exist on the connectpublic help site?
 *
 * The deck cites that map's URLs to an LLO. A renamed or deleted wiki page
 * leaves the map pointing at a 404, and nothing in the deck pipeline would
 * notice: the generator reads the committed file, the renderer places the text,
 * and every structural check passes on a slide whose "Learn more" link is dead.
 * The failure is only visible to the person who clicks it, which is the LLO.
 *
 * This is the liveness half of the map's guarantees. The repo-only half —
 * every entry well-formed, ids numeric, urls built from `base`, no invented
 * slugs — is `test/templates/connect-wiki-map.test.ts`, which runs in CI.
 * This probe deliberately does NOT run in CI: it depends on Confluence being
 * up, and a red required check every time Atlassian has a bad morning teaches
 * people to ignore red checks.
 *
 * Read-only, unauthenticated (the space is public). Exits 0 when every page
 * resolves, 2 when any page is missing, 1 on an operational failure (no
 * network, map unparseable).
 *
 * Usage:
 *   npx tsx scripts/probe-connect-wiki-map.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(
  HERE,
  '..',
  'templates',
  'training-deck',
  '_common',
  'connect-wiki-map.yaml',
);

interface WikiPage {
  id: number;
  title: string;
  url: string;
}

interface WikiMap {
  base: string;
  space_key: string;
  verified_on: string;
  sections: Record<string, { audience: string; pages: WikiPage[] }>;
}

/**
 * Ask the content API about one page id rather than fetching its HTML.
 *
 * Fetching the page URL is the wrong probe: Confluence serves a 200 SPA shell
 * for ids that do not exist, so an HTML check cannot distinguish a live page
 * from a dead one. `/rest/api/content/<id>` answers 200 or 404 honestly.
 */
async function pageExists(id: number): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`https://dimagi.atlassian.net/wiki/rest/api/content/${id}`, {
    method: 'GET',
    redirect: 'follow',
  });
  return { ok: res.status === 200, status: res.status };
}

async function main(): Promise<number> {
  let map: WikiMap;
  try {
    map = yaml.load(fs.readFileSync(MAP_PATH, 'utf8')) as WikiMap;
  } catch (err) {
    console.error(`FAIL could not read/parse ${MAP_PATH}: ${(err as Error).message}`);
    return 1;
  }

  const entries: Array<{ section: string; page: WikiPage }> = [];
  for (const [section, block] of Object.entries(map.sections ?? {})) {
    for (const page of block.pages ?? []) entries.push({ section, page });
  }

  if (entries.length === 0) {
    console.error('FAIL map declares no pages — that is not a healthy map, it is an empty one');
    return 1;
  }

  console.log(`connect-wiki-map: ${entries.length} pages, verified_on ${map.verified_on}`);

  const dead: string[] = [];
  for (const { section, page } of entries) {
    let result: { ok: boolean; status: number };
    try {
      result = await pageExists(page.id);
    } catch (err) {
      console.error(`  ERROR ${page.id} (${section}): ${(err as Error).message}`);
      return 1;
    }
    if (result.ok) {
      console.log(`  OK    ${page.id}  ${section} — ${page.title}`);
    } else {
      console.log(`  DEAD  ${page.id}  ${section} — ${page.title} (HTTP ${result.status})`);
      dead.push(`${page.id} (${section}: ${page.title})`);
    }

    // Cheap correctness check while we are here: the committed url must be
    // built from `base` and must carry the id. A url that does not contain
    // its own id has been hand-edited into a slug-only form, which breaks the
    // moment the page is renamed.
    if (!page.url.startsWith(map.base) || !page.url.includes(String(page.id))) {
      console.log(`  WARN  ${page.id} url is not <base>/...<id>...: ${page.url}`);
      dead.push(`${page.id} (malformed url)`);
    }
  }

  if (dead.length > 0) {
    console.error(`\nFAIL ${dead.length} of ${entries.length} entries need attention:`);
    for (const d of dead) console.error(`  - ${d}`);
    console.error(
      '\nFix: re-derive from the space content API\n' +
        "  curl -s 'https://dimagi.atlassian.net/wiki/rest/api/content?spaceKey=connectpublic&limit=100'\n" +
        'then update the entry (and `verified_on`) in\n' +
        '  templates/training-deck/_common/connect-wiki-map.yaml\n' +
        'Do NOT guess a replacement slug — take the id and webui path verbatim.',
    );
    return 2;
  }

  console.log(`\nPASS all ${entries.length} mapped pages resolve`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FAIL unexpected: ${err?.message ?? err}`);
    process.exit(1);
  },
);
