/**
 * Local store for CommCare HQ API keys ACE mints per project space.
 *
 * `commcare_create_api_key` creates an HQ key restricted to ONE project space
 * (HQ's `HQApiKey.domain`, enforced at auth — a key for X gets 401 on /a/Y/).
 * HQ shows the plaintext exactly once, in the create response, so the key is
 * written here — owner-only file, owner-only directory — and callers only ever
 * see a reference, `hq-key:<name>`. That keeps a live credential out of the
 * session transcript; the Connect atoms resolve the reference server-side just
 * before sending the key to Connect (the opportunity's app wiring).
 *
 * Why per-space keys at all: an opportunity stores the HQ key its apps are
 * read with. ACE's global key (`ACE_HQ_API_KEY`) reaches every ACE project
 * space, and a Connect org admin can attach any stored key id to their own
 * opportunity, so a partner's opportunity should hold a key that reaches only
 * the partner's space. Spec: ace-web docs/specs/2026-09-28-clone-and-release-design.md.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const HQ_KEY_REF_RE = /^hq-key:([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

export function hqKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACE_HQ_KEY_DIR || path.join(os.homedir(), '.ace', 'hq-api-keys');
}

function keyPath(name: string, env: NodeJS.ProcessEnv): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid HQ key name: ${JSON.stringify(name)}`);
  return path.join(hqKeyDir(env), `${name}.key`);
}

/** Store a plaintext key; returns its reference (`hq-key:<name>`). */
export function saveHqKey(name: string, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = keyPath(name, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return `hq-key:${name}`;
}

export function hasHqKey(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(keyPath(name, env));
}

/**
 * Resolve an `hq-key:<name>` reference to the stored key. Any other value is
 * returned unchanged (so `${ACE_HQ_API_KEY}` and raw keys keep working). A
 * reference with no stored key is a loud error, never an empty string.
 */
export function resolveHqKeyRef(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = HQ_KEY_REF_RE.exec(value);
  if (!m) return value;
  const file = keyPath(m[1], env);
  let key: string;
  try {
    key = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(
      `${value}: no stored HQ key (expected ${file}). Mint it with commcare_create_api_key.`,
    );
  }
  if (!key) throw new Error(`${value}: the stored HQ key file is empty (${file}).`);
  return key;
}
