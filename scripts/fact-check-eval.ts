#!/usr/bin/env npx tsx
/**
 * fact-check-eval — the deterministic grader behind three former LLM evals.
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/fact-check-eval.ts" app-release \
 *     --summary <local app-release_summary.md> \
 *     [--learn-ccz <commcare_download_ccz JSON | FAILED>] [--deliver-ccz <… | FAILED>] \
 *     [--payable-slugs <slug,slug>] [--connect-deliver-units <connect_list_deliver_units JSON | FAILED>] \
 *     --target <opp>/<run> --out <local app-release-eval_verdict.yaml>
 *
 *   … connect-opp --input <JSON: opportunity, paymentUnits, createdPaymentUnits?, deliverUnits,
 *       testUserInvite, payableDeliverSlugs?, expectedHqDeliverAppId?, archetype?>
 *       --pdd <local PDD markdown export> --run-state <local run_state.yaml>
 *       [--residue <JSON {deployability:{score,note}, archetype_config_coherence:{score,note}}>]
 *       --target <opp>/<run> --out <local connect-opp-setup-eval_verdict.yaml>
 *     Without --residue it prints the FACT half (scores + findings) and writes nothing:
 *     the skill reads it, grades the two judgment dimensions, and re-runs with --residue.
 *
 *   … ocs-widget-handoff --handoff <local ocs-setup_widget-handoff.md> --run-state <local run_state.yaml>
 *       [--no-probe] [--clarity-residue <JSON {deduction:0..2, note}>]
 *       --target <opp>/<run> --out <local ocs-widget-handoff-eval_verdict.yaml>
 *     Probes the public chat URL anonymously itself, and scans the doc for every
 *     configured secret VALUE from the plugin .env, not just secret-shaped strings.
 *
 * Why (ACE run-efficiency audit, 2026-10-16): each of these evals was an Opus
 * subagent re-reading API payloads to grade facts a comparison states exactly.
 * See lib/deterministic-verdict.ts.
 *
 * Prints `{verdict, overall_score, out}` (or the facts) as the last stdout line.
 * Exit 0 whatever the verdict; non-zero only when the script itself cannot run.
 */
import * as fs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { checkAppRelease, type CczRead } from '../lib/app-release-check.js';
import { checkConnectOppSetup, checkOppConfigFacts, type OppConfigInput } from '../lib/connect-opp-config-check.js';
import { checkWidgetHandoff, ocsUrlsIn, type ProbeResult } from '../lib/ocs-widget-handoff-check.js';
import { isLegacyOcsStartUrl, isOcsPublicLinkUrl } from '../lib/ocs-public-chat-url.js';
import { SECRET_ENV_KEYS } from '../lib/redact-secrets.js';

const [sub, ...args] = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    process.stderr.write(`fact-check-eval ${sub}: missing --${name}\n`);
    process.exit(2);
  }
  return v as string;
}
function readText(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
/** JSON file, `FAILED` sentinel → null, absent → undefined. */
function readJsonArg<T>(name: string): T | null | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  if (v === 'FAILED') return null;
  return JSON.parse(fs.readFileSync(v, 'utf8')) as T;
}
function runState(): Record<string, any> {
  const t = readText(arg('run-state'));
  return t ? ((parseYaml(t) as Record<string, any>) ?? {}) : {};
}
function write(verdict: Record<string, unknown>): void {
  const out = need('out');
  fs.writeFileSync(out, stringifyYaml(verdict));
  console.log(JSON.stringify({ verdict: verdict.verdict, overall_score: verdict.overall_score, out }));
}

async function main(): Promise<void> {
  const target = need('target');
  if (sub === 'app-release') {
    const v = checkAppRelease({
      target,
      releaseSummaryText: readText(need('summary')),
      ccz: { learn: readJsonArg<CczRead>('learn-ccz'), deliver: readJsonArg<CczRead>('deliver-ccz') },
      payableDeliverSlugs: arg('payable-slugs')?.split(',').map((s) => s.trim()).filter(Boolean),
      connectDeliverUnits: readJsonArg<Array<{ slug?: string }>>('connect-deliver-units'),
    });
    write(v as Record<string, unknown>);
    return;
  }

  if (sub === 'connect-opp') {
    const live = JSON.parse(fs.readFileSync(need('input'), 'utf8')) as Partial<OppConfigInput>;
    const rs = runState();
    const products = rs?.phases?.['connect-setup']?.products?.connect ?? null;
    const input: OppConfigInput = {
      target,
      archetype: live.archetype ?? rs?.phases?.['idea-to-design']?.products?.pdd?.archetype,
      pddText: readText(arg('pdd')),
      products,
      opportunity: live.opportunity ?? null,
      paymentUnits: live.paymentUnits ?? null,
      createdPaymentUnits: live.createdPaymentUnits,
      deliverUnits: live.deliverUnits ?? null,
      testUserInvite: live.testUserInvite ?? null,
      payableDeliverSlugs: live.payableDeliverSlugs,
      expectedHqDeliverAppId: live.expectedHqDeliverAppId ?? rs?.phases?.['commcare-setup']?.products?.apps?.deliver?.hq_app_id,
      expectedPaymentUnitCount: live.expectedPaymentUnitCount,
    };
    const residuePath = arg('residue');
    if (!residuePath) {
      const facts = checkOppConfigFacts(input);
      console.log(JSON.stringify({ stage: 'facts', next: 're-run with --residue after grading deployability + archetype_config_coherence', ...facts }));
      return;
    }
    input.residue = JSON.parse(fs.readFileSync(residuePath, 'utf8'));
    write(checkConnectOppSetup(input) as Record<string, unknown>);
    return;
  }

  if (sub === 'ocs-widget-handoff') {
    loadPluginEnv(import.meta.url);
    const handoffText = readText(need('handoff'));
    const rs = runState();
    const chatbot = rs?.phases?.['ocs-setup']?.products?.ocs_chatbot ?? null;
    const conn = rs?.phases?.['connect-setup']?.products?.connect?.opportunity ?? rs?.connect_opportunity ?? null;
    let probe: ProbeResult | null | undefined;
    const url = handoffText ? ocsUrlsIn(handoffText).find((u) => isOcsPublicLinkUrl(u) || isLegacyOcsStartUrl(u)) : undefined;
    if (!args.includes('--no-probe') && url) {
      try {
        const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ace-fact-check-eval' } });
        probe = { status: res.status, body: (await res.text()).slice(0, 20000) };
      } catch {
        probe = null;
      }
    }
    const secretValues: Record<string, string> = {};
    for (const k of [...SECRET_ENV_KEYS, 'OCS_GOLDEN_TEMPLATE_ID', 'NOVA_API_KEY']) {
      const v = process.env[k];
      if (v) secretValues[k] = v;
    }
    const v = checkWidgetHandoff({
      target,
      handoffText,
      chatbot,
      opportunity: conn,
      probe,
      secretValues,
      clarityResidue: readJsonArg('clarity-residue') ?? null,
    });
    write(v as Record<string, unknown>);
    return;
  }

  process.stderr.write('usage: fact-check-eval.ts <app-release|connect-opp|ocs-widget-handoff> …\n');
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`fact-check-eval: ${(e as Error).message}\n`);
  process.exit(1);
});
