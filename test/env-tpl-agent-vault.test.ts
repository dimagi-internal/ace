/**
 * No 1Password vault is named in ACE's templates — refs read `${AGENT_VAULT}`.
 *
 * An install binds to ONE canopy-web agent instance, and that instance's recorded
 * vault (`op_vault`) supplies the secrets (canopy#899). `canopy agent env` (run by
 * /ace:setup), `canopy cred`, the cloud runner (canopy-web#1478) and the SessionStart
 * hook all export AGENT_VAULT before `op inject`; a literal agent vault here would
 * ignore the binding and read the wrong vault for any other instance.
 *
 * runtime.yaml follows suit for the same refs (its `op:` must equal what .env.tpl
 * injects — test/lib/runtime-secret-sources.test.ts). canopy-web only checks that an
 * `op:` source exists (vault_import.plan_import), so the variable form stays
 * "locatable". The fleet-SHARED vault is not the instance's and stays literal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const SCHEME = `op:${'/'}${'/'}`;
const VAR_REF = `${SCHEME}\${AGENT_VAULT}/`;
const SHARED = `${SCHEME}Canopy-Shared/`;

function tplRefs(): string[] {
  const out: string[] = [];
  for (const line of readFileSync(join(ROOT, '.env.tpl'), 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value.startsWith(SCHEME)) out.push(value);
  }
  return out;
}

describe('.env.tpl reads the bound instance vault', () => {
  it('names no agent vault literally', () => {
    expect(readFileSync(join(ROOT, '.env.tpl'), 'utf8')).not.toContain(`${SCHEME}Agent-`);
  });

  it('every reference goes through ${AGENT_VAULT}', () => {
    const refs = tplRefs();
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.startsWith(VAR_REF))).toEqual([]);
  });
});

describe('runtime.yaml op sources match', () => {
  const secrets: Array<Record<string, unknown>> = parse(
    readFileSync(join(ROOT, 'runtime.yaml'), 'utf8'),
  ).secrets;

  it('names no agent vault literally', () => {
    const literal = secrets.filter((s) => String(s.op ?? '').startsWith(`${SCHEME}Agent-`));
    expect(literal.map((s) => s.name)).toEqual([]);
  });

  it('every op source is the instance vault or the shared vault', () => {
    const other = secrets.filter(
      (s) => 'op' in s && !String(s.op).startsWith(VAR_REF) && !String(s.op).startsWith(SHARED),
    );
    expect(other.map((s) => `${s.name}: ${s.op}`)).toEqual([]);
  });
});
