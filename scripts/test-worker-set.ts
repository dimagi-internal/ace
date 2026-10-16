/**
 * Store one Connect test worker's data on canopy-web, as ACE (ace#2955).
 *
 * Owner directive (Jon, 2026-10-15): every pool worker's phone, phoneLocal,
 * countryCode, name, PIN and backup code live in canopy-web as per-slot data
 * on ACE's `test-worker` pool capability — each slot its own PIN and backup
 * code, even where the values match. A ready lease hands its holder that
 * slot's data; this script is how the data gets there.
 *
 *   # one slot — secrets ONLY from env vars (named by flag) or stdin, never argv
 *   PIN=… BACKUP_CODE=… npx tsx scripts/test-worker-set.ts --slot worker-2 \
 *     --phone +74260000102 --phone-local 4260000102 --country-code +7 \
 *     --name "ACE Test 2" --pin-env PIN --backup-code-env BACKUP_CODE
 *
 *   # secrets as JSON on stdin: {"pin": "…", "backupCode": "…"}
 *   … --secrets-stdin < secrets.json
 *
 *   # this machine's legacy ACE_E2E_* PIN + backup code (from ACE's .env) for a
 *   # slot registered with them — the add-worker walk's default
 *   … --slot worker-5 --phone … --secrets-from-legacy-env
 *
 *   # seed worker-1 entirely from the legacy ACE_E2E_* worker
 *   npx tsx scripts/test-worker-set.ts --from-legacy-env
 *
 *   npx tsx scripts/test-worker-set.ts --list            # masked slot table
 *   npx tsx scripts/test-worker-set.ts --delete --slot worker-3   # retire
 *
 *   --partial   send only the keys given (e.g. rotate a PIN); skips the
 *               full-identity validation
 *   --dry-run   print the masked request; send nothing
 *
 * Writes with ACE's own canopy-web PAT (CANOPY_WEB_PAT in ACE's .env), which
 * canopy-web allows for the agent's own slots. Prints only canopy-web's MASKED
 * answer: no secret value ever reaches stdout, stderr or an error message.
 */
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import { aceEnvValue } from '../lib/ace-canopy-pat.js';
import {
  DEMO_COUNTRY_CODE,
  LEGACY_SLOT,
  SLOT_RE,
  maskSecretsDeep,
  missingSlotKeys,
  publicIdentityProblems,
  redactSecrets,
} from '../lib/test-worker-pool.js';
import {
  classifySlotData,
  deleteSlotData,
  listSlots,
  putSlotData,
  slotHttpConfig,
  type SlotRow,
} from '../lib/test-worker-slots.js';

export type SetAction =
  | { kind: 'list' }
  | { kind: 'delete'; slot: string }
  | {
      kind: 'put';
      slot: string;
      body: { public: Record<string, string>; secret: Record<string, string> };
      dryRun: boolean;
    };

export class SetArgsError extends Error {}

/** Flags that would put a secret on argv (visible in `ps`, shell history, transcripts). */
const SECRET_ARGV = /^--(pin|backup-?code|backupCode|secret|secrets)(=|$)/i;

const LEGACY_KEYS = ['ACE_E2E_PHONE', 'ACE_E2E_PHONE_LOCAL', 'ACE_E2E_COUNTRY_CODE', 'ACE_E2E_PIN', 'ACE_E2E_BACKUP_CODE', 'ACE_E2E_NAME'];

/** ACE's .env values for the legacy worker keys, under process.env. */
export function legacyEnv(env: NodeJS.ProcessEnv = process.env, read: (k: string) => string | null = aceEnvValue): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of LEGACY_KEYS) {
    const v = (out[k] ?? '').trim();
    if (!v || v.startsWith('op://')) {
      const r = read(k);
      if (r) out[k] = r;
    }
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new SetArgsError(`${name} needs a value`);
  return v;
}

/**
 * Pure: argv (+ env, + stdin text) → what to do. Refuses a secret on argv
 * outright, naming the safe alternatives, and never echoes the value.
 */
export function parseSetArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin?: string): SetAction {
  for (const a of argv) {
    if (SECRET_ARGV.test(a)) {
      throw new SetArgsError(
        `refusing ${a.split('=')[0]}: secrets never go on argv (process list, shell history, transcripts). ` +
          'Use --pin-env VAR / --backup-code-env VAR, --secrets-stdin, or --secrets-from-legacy-env.',
      );
    }
  }
  if (argv.includes('--list')) return { kind: 'list' };
  const fromLegacy = argv.includes('--from-legacy-env');
  const slot = flag(argv, '--slot') ?? (fromLegacy ? LEGACY_SLOT : undefined);
  if (!slot) throw new SetArgsError('--slot worker-N is required (or --from-legacy-env for worker-1)');
  if (!SLOT_RE.test(slot)) throw new SetArgsError(`--slot must be worker-<n>, got "${slot}"`);
  if (argv.includes('--delete')) return { kind: 'delete', slot };

  const pub: Record<string, string> = {};
  const sec: Record<string, string> = {};
  if (fromLegacy) {
    const put = (k: string, v: string | undefined, into: Record<string, string>) => {
      const t = (v ?? '').trim();
      if (t && !t.startsWith('op://')) into[k] = t;
    };
    put('phone', env.ACE_E2E_PHONE, pub);
    put('phoneLocal', env.ACE_E2E_PHONE_LOCAL, pub);
    put('countryCode', env.ACE_E2E_COUNTRY_CODE || DEMO_COUNTRY_CODE, pub);
    put('name', env.ACE_E2E_NAME || 'ACE Test', pub);
    put('pin', env.ACE_E2E_PIN, sec);
    put('backupCode', env.ACE_E2E_BACKUP_CODE, sec);
  }
  const p = (name: string, key: string) => {
    const v = flag(argv, name);
    if (v !== undefined) pub[key] = v.trim();
  };
  p('--phone', 'phone');
  p('--phone-local', 'phoneLocal');
  p('--country-code', 'countryCode');
  p('--name', 'name');

  if (argv.includes('--secrets-from-legacy-env')) {
    if (env.ACE_E2E_PIN?.trim()) sec.pin = env.ACE_E2E_PIN.trim();
    if (env.ACE_E2E_BACKUP_CODE?.trim()) sec.backupCode = env.ACE_E2E_BACKUP_CODE.trim();
  }
  const fromEnv = (name: string, key: string) => {
    const varName = flag(argv, name);
    if (varName === undefined) return;
    const v = (env[varName] ?? '').trim();
    if (!v) throw new SetArgsError(`${name} ${varName}: that environment variable is unset or empty`);
    sec[key] = v;
  };
  fromEnv('--pin-env', 'pin');
  fromEnv('--backup-code-env', 'backupCode');
  if (argv.includes('--secrets-stdin')) {
    let j: unknown;
    try {
      j = JSON.parse(stdin ?? '');
    } catch {
      throw new SetArgsError('--secrets-stdin: stdin is not JSON like {"pin": "…", "backupCode": "…"}');
    }
    const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
    for (const [k, alias] of [['pin', 'pin'], ['backupCode', 'backup_code']] as const) {
      const v = o[k] ?? o[alias];
      if (typeof v === 'string' && v.trim()) sec[k] = v.trim();
      else if (typeof v === 'number') sec[k] = String(v);
    }
  }

  if (!argv.includes('--partial')) {
    const missing = missingSlotKeys(Object.keys(pub), Object.keys(sec));
    if (missing.length) {
      throw new SetArgsError(`${slot}: missing ${missing.join(', ')} — every slot carries all six keys (use --partial to update some)`);
    }
    const problems = publicIdentityProblems({ phone: pub.phone, phoneLocal: pub.phoneLocal, countryCode: pub.countryCode });
    if (problems.length) throw new SetArgsError(`${slot}: ${problems.join('; ')}`);
  } else if (!Object.keys(pub).length && !Object.keys(sec).length) {
    throw new SetArgsError('--partial with nothing to set');
  }
  return { kind: 'put', slot, body: { public: pub, secret: sec }, dryRun: argv.includes('--dry-run') };
}

/** The masked slot table `--list` prints. */
export function formatSlotTable(rows: SlotRow[]): string {
  const report = classifySlotData(null, rows);
  const status = new Map(report.slots.map((s) => [s.slot, s]));
  const lines = ['slot       phone          name            secret keys          held   updated'];
  for (const r of rows) {
    const s = status.get(r.slot);
    const gaps = s && (s.missing.length || s.problems.length) ? `  !! ${[...s.missing.map((m) => `lacks ${m}`), ...s.problems].join('; ')}` : '';
    lines.push(
      [
        r.slot.padEnd(10),
        String(r.public.phone ?? '-').padEnd(14),
        String(r.public.name ?? '-').padEnd(15),
        (r.secretKeys.join(',') || '-').padEnd(20),
        (r.held === null ? '?' : r.held ? 'yes' : 'no').padEnd(6),
        `${r.updatedAt ?? '-'}${r.updatedBy ? ` by ${r.updatedBy}` : ''}`,
      ].join(' ') + gaps,
    );
  }
  if (!rows.length) lines.push('(no slot data on canopy-web)');
  return lines.join('\n');
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv = process.argv.slice(2), fetchImpl?: typeof fetch, token?: string | null): Promise<number> {
  let secretsSeen: string[] = [];
  try {
    const env = legacyEnv();
    const stdin = argv.includes('--secrets-stdin') ? await readStdin() : undefined;
    const action = parseSetArgs(argv, env, stdin);
    const cfg = slotHttpConfig({ fetchImpl, token });
    if (action.kind === 'list') {
      console.log(formatSlotTable(await listSlots(cfg)));
      return 0;
    }
    if (action.kind === 'delete') {
      const r = await deleteSlotData(cfg, action.slot);
      console.log(`deleted ${action.slot}'s slot data (${r.via})`);
      return 0;
    }
    secretsSeen = Object.values(action.body.secret);
    if (action.dryRun) {
      console.log(JSON.stringify({ slot: action.slot, ...(maskSecretsDeep(action.body) as object) }, null, 2));
      return 0;
    }
    const res = await putSlotData(cfg, action.slot, action.body);
    console.log(JSON.stringify(res, null, 2));
    return 0;
  } catch (e) {
    // Belt and braces: whatever the error, no secret value we read leaves.
    const remediation = (e as { remediation?: string }).remediation;
    console.error(`test-worker-set: ${redactSecrets((e as Error).message, secretsSeen)}`);
    if (remediation) console.error(`  fix: ${redactSecrets(remediation, secretsSeen)}`);
    return e instanceof SetArgsError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(await main());
}
