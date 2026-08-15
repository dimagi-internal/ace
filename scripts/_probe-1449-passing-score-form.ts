/**
 * ace#1449 ground truth: why does `connect_set_learn_passing_score` fail with
 * `hq_server: This field is required`?
 *
 * Read-only. GETs the program-scoped init-edit form for a live opportunity and
 * prints exactly what `extractFormFieldValues` / `extractDisabledFormFieldNames`
 * see, next to the RAW markup for the fields in question. No POST.
 */
import 'dotenv/config';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import {
  extractFormFieldValues,
  extractDisabledFormFieldNames,
} from '../mcp/connect/backends/html-scrape.js';
import * as fs from 'node:fs';

const ORG  = process.env.PROBE_ORG  ?? 'ai-demo-space';
const PROG = process.env.PROBE_PROG ?? 'efb8af66-fbfd-488f-bf99-66f864cea68b';
const OPP  = process.env.PROBE_OPP  ?? '94d2c7ec-bd5b-4acc-983e-3e8aebf5416c';

const session = new PlaywrightSession({
  baseUrl: process.env.CONNECT_BASE_URL!,
  hqUsername: process.env.ACE_HQ_USERNAME,
  hqPassword: process.env.ACE_HQ_PASSWORD,
});
const ctx = await session.getContext();

const path = `/a/${ORG}/program/${PROG}/opportunity/${OPP}/init/edit/`;
const res = await ctx.request.get(path);
console.log(`GET ${path} -> ${res.status()}`);
if (res.status() !== 200) { await session.close(); process.exit(1); }

const html = await res.text();
fs.writeFileSync('/tmp/1449-init-edit.html', html);
console.log(`saved ${html.length} chars to /tmp/1449-init-edit.html\n`);

const values   = extractFormFieldValues(html);
const disabled = extractDisabledFormFieldNames(html);

console.log('=== what the extractor sees ===');
for (const k of Object.keys(values).sort()) {
  const v = values[k];
  console.log(
    `${disabled.has(k) ? 'DISABLED' : '        '}  ${k.padEnd(28)} = ${
      v === '' ? '<<EMPTY>>' : JSON.stringify(v.slice(0, 60))}`,
  );
}

console.log('\n=== disabled set ===');
console.log([...disabled].join(', ') || '(none)');

console.log('\n=== RAW markup for the selects that matter ===');
for (const field of ['hq_server', 'api_key', 'learn_app', 'learn_app_domain']) {
  const m = html.match(new RegExp(`<select\\b[^>]*name="${field}"[\\s\\S]*?</select>`));
  if (!m) { console.log(`\n--- ${field}: NO <select> FOUND ---`); continue; }
  const block = m[0];
  console.log(`\n--- ${field} (${block.length} chars) ---`);
  console.log(block.slice(0, 700));
  const selectedOpts = [...block.matchAll(/<option[^>]*\sselected[^>]*>/g)].map((x) => x[0]);
  console.log(`  selected option(s): ${selectedOpts.length ? selectedOpts.join(' | ') : '*** NONE ***'}`);
  // The exact regex the extractor uses today.
  const cur = block.match(/<option\s+value="([^"]*)"[^>]*\sselected\b/);
  console.log(`  current regex captures: ${cur ? JSON.stringify(cur[1]) : '*** NO MATCH -> "" ***'}`);
}

console.log('\n=== required attributes ===');
for (const m of html.matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)) {
  const name = m[1].match(/\bname="([^"]+)"/)?.[1];
  if (name && /\brequired\b/.test(m[1])) console.log(`  required: ${name}`);
}

await session.close();
