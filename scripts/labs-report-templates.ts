#!/usr/bin/env npx tsx
/**
 * ACE's Labs template workflows — follow at build, freeze at run end, and the
 * DDD loop's draft → preview → publish cycle. Logic: lib/labs-report-templates.ts
 * and lib/labs-template-draft.ts (read their headers for the why).
 *
 *   ensure                                   check config/labs-report-templates.yaml's templates are live,
 *                                            public, the right type and editable (exit 1 on a problem)
 *   follow  --run-state RS.yaml --out P.json  point the run's cascade reports at the ACE templates;
 *                                            P.json is an update_yaml_file patch (merge: 'deep')
 *   freeze  --run-state RS.yaml --out P.json  fork every report off its template (end of Phase 7, ANY
 *                                            terminal status) and record the version each kept
 *   refollow --run-state RS.yaml [--apply]    print (or make) the one call per frozen report that puts
 *                                            it back on its template — its page then changes on every publish
 *   dispatch-block --run-state RS.yaml       the canopy:ddd dispatch-prompt block: which page follows which
 *                                            template, and the draft procedure below (Phase 7 Step 3)
 *   draft-begin   --template <type|id>        take the draft lease → {status: ready|busy, revision}
 *   draft-url     --url <scene url>           the same page with the draft applied (&template_draft=1)
 *   draft-capture --url <scene url> --out PNG [--click "<button text>"] [--no-draft] [--full-page]
 *                 [--storage-state ~/.ace/labs-session.json] [--width 1280 --height 720]
 *                                            screenshot the scene's page WITH the draft, as the ACE identity
 *                                            (--no-draft: the published page, for the before-frame)
 *   draft-decide  --before B.json --after A.json   {"<scene>::<dim>": score} → publish | discard (exit 0 / 3)
 *   draft-publish --template <type|id> --expected-revision N --note "<what, run, finding>"
 *   draft-discard --template <type|id>        reset the draft's render to the published version
 *
 * Requires LABS_MCP_TOKEN (loaded from the plugin-data .env; /ace:labs-token-mint),
 * except draft-url / draft-decide, which are pure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { makeLabsCall } from '../lib/labs-rpc.js';
import {
  cascadeOf,
  checkTemplates,
  dddDispatchBlock,
  followRunReports,
  freezeRunReports,
  loadReportTemplatesConfig,
  recordedBlock,
  refollowArgs,
  reportTemplatesPatch,
} from '../lib/labs-report-templates.js';
import {
  beginDraft,
  discardDraft,
  draftPreviewUrl,
  publishDecision,
  publishDraft,
} from '../lib/labs-template-draft.js';

loadPluginEnv(import.meta.url);

const argv = process.argv.slice(2);
const cmd = argv[0];
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v || v.startsWith('--')) die(`--${name} is required`);
  return v!;
}
function die(msg: string, code = 1): never {
  process.stderr.write(`labs-report-templates: ${msg}\n`);
  process.exit(code);
}
const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const readRunState = () => parseYaml(fs.readFileSync(need('run-state'), 'utf8'));
const expandHome = (p: string) => (p.startsWith('~/') ? os.homedir() + p.slice(1) : p);

async function main() {
  const cfg = loadReportTemplatesConfig();
  switch (cmd) {
    case 'ensure': {
      const health = await checkTemplates(makeLabsCall(), cfg);
      print({ home: cfg.home, templates: health });
      if (health.some((h) => !h.ok)) process.exit(1);
      return;
    }
    case 'follow':
    case 'freeze': {
      const rs = readRunState();
      const cascade = cascadeOf(rs);
      if (!cascade) die('run_state has no phases.synthetic-data-and-workflows.products.synthetic.cascade — nothing to ' + cmd);
      const call = makeLabsCall();
      const block = cmd === 'follow'
        ? await followRunReports(call, cascade, cfg)
        : await freezeRunReports(call, cascade, cfg, recordedBlock(rs));
      fs.writeFileSync(need('out'), JSON.stringify(reportTemplatesPatch(block), null, 2) + '\n');
      print(block);
      if (!block.reports.length) die('the cascade names no report workflows', 1);
      return;
    }
    case 'refollow': {
      const block = recordedBlock(readRunState());
      if (!block) die('run_state records no cascade.report_templates');
      const calls = block!.reports.filter((r) => r.state === 'frozen').map((r) => refollowArgs(r, cfg)).filter(Boolean) as Record<string, unknown>[];
      if (argv.includes('--apply')) {
        const call = makeLabsCall();
        for (const a of calls) print(await call('workflow_follow_template', a));
      } else {
        print(calls.map((a) => ({ tool: 'workflow_follow_template', args: a })));
      }
      return;
    }
    case 'dispatch-block': {
      const rs = readRunState();
      process.stdout.write(dddDispatchBlock(cfg, recordedBlock(rs), cascadeOf(rs)));
      return;
    }
    case 'draft-begin': {
      const r = await beginDraft(makeLabsCall(), cfg, need('template'));
      print(r);
      if (r.status === 'busy') process.exit(3);
      return;
    }
    case 'draft-url':
      process.stdout.write(draftPreviewUrl(need('url')) + '\n');
      return;
    case 'draft-capture': {
      const { chromium } = await import('playwright');
      const state = expandHome(arg('storage-state') ?? '~/.ace/labs-session.json');
      if (!fs.existsSync(state)) die(`no labs session at ${state} — run /ace:labs-login (Phase 7 Step 3.0)`);
      // --no-draft captures the PUBLISHED page — the before-frame of an A/B.
      const url = argv.includes('--no-draft') ? need('url') : draftPreviewUrl(need('url'));
      const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({
          storageState: state,
          viewport: { width: Number(arg('width') ?? 1280), height: Number(arg('height') ?? 720) },
        });
        const page = await ctx.newPage();
        // Not 'networkidle': a labs run page keeps polling, so it never goes idle
        // (measured 2026-10-16: 120 s timeout on every report page).
        const res = await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
        await page.waitForTimeout(Number(arg('settle-ms') ?? 8000));
        if (/\/accounts\/login|oauth/i.test(page.url())) die(`redirected to login (${page.url()}) — refresh the labs session`);
        // Labs draws a "Previewing the draft (revision N)…" notice on a draft
        // preview. Followers never see it, so a frame judged with it in is not
        // the page that would ship — drop it (only the notice, by its text).
        if (!argv.includes('--no-draft') && !argv.includes('--keep-draft-notice')) {
          await page.evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('div,section,aside'))) {
              const t = (el.textContent ?? '').trim();
              if (t.startsWith('Previewing the draft') && t.length < 300) {
                el.remove();
                break;
              }
            }
          });
        }
        // A scene that opens a tab first (the opp report's Benchmarks) — same click the recipe makes.
        const click = arg('click');
        if (click) {
          // By visible text: R.Tabs renders tabs that are not role=button.
          await page.getByText(click, { exact: true }).first().click({ timeout: 30_000 });
          await page.waitForTimeout(Number(arg('settle-ms') ?? 4000));
        }
        await page.screenshot({ path: need('out'), fullPage: argv.includes('--full-page') });
        print({ url, final_url: page.url(), status: res?.status() ?? null, out: arg('out') });
      } finally {
        await browser.close();
      }
      return;
    }
    case 'draft-decide': {
      const d = publishDecision(JSON.parse(fs.readFileSync(need('before'), 'utf8')), JSON.parse(fs.readFileSync(need('after'), 'utf8')));
      print(d);
      if (d.decision !== 'publish') process.exit(3);
      return;
    }
    case 'draft-publish': {
      const rev = Number(need('expected-revision'));
      if (!Number.isInteger(rev) || rev < 1) die('--expected-revision must be the draft revision your edit produced');
      print(await publishDraft(makeLabsCall(), cfg, need('template'), rev, need('note')));
      return;
    }
    case 'draft-discard':
      print(await discardDraft(makeLabsCall(), cfg, need('template')));
      return;
    default:
      die(`unknown command ${cmd ?? '(none)'} — see the header of scripts/labs-report-templates.ts`);
  }
}

main().catch((e) => die((e as Error).message));
