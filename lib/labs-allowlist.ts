/**
 * lib/labs-allowlist.ts — widen a labs-only synthetic opp's email-domain
 * allowlist without dropping anyone (ace#2713).
 *
 * `synthetic_set_allowed_domains` REPLACES the list. ACE (`ace@dimagi-ai.com`)
 * is not `@dimagi.com` staff: it reads its own Phase 7 opps only because they
 * were created with `allowed_domains: ['@dimagi.com', '@dimagi-ai.com']`
 * (`skills/demo-data-setup` § C1). On 2026-10-05 `clone-to-new-workspace` § 4c
 * sent only the partner's domain, so ACE lost its own synthetic org
 * (`benchmarks_publish`: "is not accessible to your account").
 *
 * Labs has no read atom for the current list. The write's reply carries
 * `previous_allowed_domains`, and that reply is the read: `reconcileAfterSet`
 * checks it and returns the union to resend when the write dropped a domain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** `Foo.org` / `@foo.org` → `@foo.org`. */
export function normalizeLabsDomain(d: string): string {
  const v = String(d).trim().toLowerCase();
  if (!v) return '';
  return v.startsWith('@') ? v : `@${v}`;
}

function normSet(list: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const d of list ?? []) {
    const n = normalizeLabsDomain(d);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/** ACE's own mailbox domain, from `config/agent.json` `email` (the single source). */
export function aceMailboxDomain(repoRoot: string): string {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'agent.json'), 'utf8')) as { email?: string };
  const at = (raw.email ?? '').lastIndexOf('@');
  if (at < 0) throw new Error('config/agent.json has no `email` — cannot derive ACE\'s own labs domain');
  return normalizeLabsDomain(raw.email!.slice(at));
}

export interface CloneLabsAllowlistInput {
  /** The opp's list as known before the write (a recorded list, or a prior reply's previous_allowed_domains). */
  current?: readonly string[] | null;
  /** The target tenancy's `labs_allowed_domains`. */
  target: readonly string[];
  /** ACE's own mailbox domain (`aceMailboxDomain`). */
  aceDomain: string;
}

/** current ∪ target ∪ ACE's own domain, normalised and sorted. Never a bare replace. */
export function cloneLabsAllowlist(input: CloneLabsAllowlistInput): string[] {
  const target = normSet(input.target);
  if (target.length === 0) {
    throw new Error('target tenancy has no labs_allowed_domains — nothing to widen the opp to');
  }
  const ace = normalizeLabsDomain(input.aceDomain);
  if (!ace) throw new Error('ACE\'s own mailbox domain is required — without it ACE locks itself out (ace#2713)');
  return normSet([...(input.current ?? []), ...target, ace]);
}

export interface ReconcileResult {
  /** Domains the opp had before the write that the write removed. */
  dropped: string[];
  /** sent ∪ previous when something was dropped, else null. */
  resend: string[] | null;
}

/** Compare what was sent with the reply's `previous_allowed_domains`. */
export function reconcileAfterSet(args: { sent: readonly string[]; previous: readonly string[] | null | undefined }): ReconcileResult {
  const sent = normSet(args.sent);
  const previous = normSet(args.previous);
  const dropped = previous.filter((d) => !sent.includes(d));
  return { dropped, resend: dropped.length ? normSet([...sent, ...previous]) : null };
}

/**
 * Does a `labs_context` reply list this opportunity? Walks every array under a
 * key naming opportunities (org → program → opportunity), so a PROGRAM that
 * shares the opp's id does not count as a sighting.
 */
export function labsContextShowsOpportunity(context: unknown, opportunityId: number | string): boolean {
  const want = String(opportunityId);
  const walk = (node: unknown, inOpps: boolean): boolean => {
    if (Array.isArray(node)) return node.some((n) => walk(n, inOpps));
    if (!node || typeof node !== 'object') return false;
    const obj = node as Record<string, unknown>;
    if (inOpps && obj.id !== undefined && String(obj.id) === want) return true;
    return Object.entries(obj).some(([k, v]) =>
      typeof v === 'object' && v !== null && walk(v, /opportunit/i.test(k)));
  };
  return walk(context, false);
}
