/**
 * `ocs-widget-handoff-eval`, as code (rubric = `skills/ocs-widget-handoff-eval/SKILL.md`,
 * which stays the spec; see `lib/deterministic-verdict.ts` for why fact-check
 * evals stopped being LLM judges).
 *
 * | dimension                      | weight | how |
 * |--------------------------------|--------|-----|
 * | widget_url_resolves            | 0.25   | the handoff's OCS URL is the public link `/c/<token>/` (legacy `/start/` ≤ 6 — OCS is removing it, #4209; the retired `/chatbots/embed/` ≤ 3), `public_id` + `embed_key` present, and an anonymous probe answers 200 with neither "not published" banner (a 503 maintenance page is PLATFORM, never a deduction — ace#1812) |
 * | connect_opp_binding            | 0.20   | the handoff names the opportunity run_state records; a different opportunity id = −4, none = ≤ 4 |
 * | operator_instructions_clarity  | 0.30   | three elements present (share-the-link, verify-the-bot incl. the `public_id` as the RUN check — ace#2488, what embed_key is for once CCC-301 ships), −2 each missing; a phantom Connect paste-in instruction is an auto-fail ≤ 3 (ace#1811). The ONLY judgment left: the skill may deduct up to 2 more for readability, with a reason |
 * | credential_hygiene             | 0.25   | no cross-opportunity credential in the doc (named env keys with a value, auth headers, PEM, 1Password refs, AWS keys, or any configured secret VALUE verbatim). `link_token`, `team_slug`, `public_id`, `embed_key` are public-by-construction and never a finding (ace#1680) |
 */
import type { AutoSurfaced, CheckRecord, Verdict } from './verdict-schema.js';
import { SECRET_ENV_KEYS } from './redact-secrets.js';
import { isLegacyOcsStartUrl, isOcsPublicLinkUrl } from './ocs-public-chat-url.js';
import { composeVerdict, incompleteVerdict, type ScoredDimension } from './deterministic-verdict.js';

export const WIDGET_WEIGHTS = {
  widget_url_resolves: 0.25,
  connect_opp_binding: 0.2,
  operator_instructions_clarity: 0.3,
  credential_hygiene: 0.25,
} as const;

/** Instructions that send a reader to a Connect widget field that does not exist (ace#1811). */
export const PHANTOM_PASTE_TARGET: RegExp[] = [
  /paste\s+(?:them|it|the\s+\w+)?\s*into\s+the\s+Connect/i,
  /paste\s+INTO\b/,
  /where\s+to\s+paste\s*\(/i,
  /find\s+the\s+\*{0,2}support\s+chatbot\s*\/?\s*help\s+widget\*{0,2}\s+field\s+group/i,
  /Connect\s+opp\s+config\s+tab/i,
];

/** Cross-opportunity credentials by NAME (a value must follow). */
const CREDENTIAL_KEYS = [...SECRET_ENV_KEYS, 'OCS_GOLDEN_TEMPLATE_ID', 'NOVA_API_KEY', 'ACE_CONNECT_PASSWORD'];
const VAL = `[^\\s"'\\\\,}{;&|]{4,}`;
const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'named-secret-env-key', re: new RegExp(`\\b(?:${CREDENTIAL_KEYS.join('|')})\\b"?\\s*[:=]\\s*"?${VAL}`) },
  { name: 'authorization-header', re: new RegExp(`\\b(?:Bearer|ApiKey|Basic|Token)\\s+${VAL}`) },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'op-ref', re: /op:\/\/[^\s"'\\,}{]+/ },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

export interface CredentialLeak {
  rule: string;
  /** Redacted excerpt — never echo the secret itself into a verdict. */
  excerpt: string;
}

/** Find cross-opportunity credentials in an LLO-facing document. */
export function findCredentialLeaks(text: string, secretValues: Record<string, string> = {}): CredentialLeak[] {
  const leaks: CredentialLeak[] = [];
  for (const { name, re } of LEAK_PATTERNS) {
    const m = re.exec(text);
    if (m) leaks.push({ rule: name, excerpt: `${m[0].slice(0, 12)}…[REDACTED]` });
  }
  for (const [key, value] of Object.entries(secretValues)) {
    if (value && value.length >= 8 && text.includes(value)) leaks.push({ rule: `verbatim-value:${key}`, excerpt: `${key}=[REDACTED]` });
  }
  return leaks;
}

/** Every openchatstudio URL in the text. */
export function ocsUrlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)<>"'`\]]*openchatstudio\.com[^\s)<>"'`\]]*/gi)].map((m) => m[0].replace(/[.,;]+$/, ''));
}

export interface ProbeResult {
  status: number;
  /** First few KB of the body, for the banner check. */
  body?: string;
}

export interface WidgetHandoffInput {
  target: string;
  /** Text of `5-ocs/ocs-setup_widget-handoff.md`; null when absent. */
  handoffText: string | null;
  /** `products.ocs_chatbot` from run_state (`public_id`, `embed_key`, `public_url`, …). */
  chatbot?: { public_id?: string; embed_key?: string; public_url?: string } | null;
  /** run_state `connect_opportunity.url` / `products.connect.opportunity.{id,url}`. */
  opportunity?: { id?: string; url?: string } | null;
  /** Anonymous probe of the public URL. null = failed (network); undefined = skipped (offline / dry-run). */
  probe?: ProbeResult | null;
  /** Configured secret values (from the plugin .env) to scan for verbatim. */
  secretValues?: Record<string, string>;
  /** Optional readability deduction from the skill's judgment pass: `{deduction: 0..2, note}`. */
  clarityResidue?: { deduction?: unknown; note?: unknown } | null;
  ranAt?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NOT_PUBLISHED = /This chatbot is not published yet|This chatbot is temporarily unavailable/i;

export function checkWidgetHandoff(input: WidgetHandoffInput): Verdict {
  const capturePath = '5-ocs/ocs-setup_widget-handoff.md';
  if (!input.handoffText || !input.handoffText.trim()) {
    return incompleteVerdict({
      skill: 'ocs-widget-handoff-eval',
      target: input.target,
      capturePath,
      ranAt: input.ranAt,
      dimensionWeights: { ...WIDGET_WEIGHTS },
      reason: 'widget-handoff.md not found — Phase 5 ocs-setup did not write the staging artifact',
    });
  }
  const text = input.handoffText;
  const body = text.split(/^\|\s*Date\s*\|\s*Change\s*\|/m)[0];
  const auto: AutoSurfaced[] = [];
  const checks: CheckRecord[] = [];
  let live = true;

  // ── widget_url_resolves ───────────────────────────────────────────────
  const urls = ocsUrlsIn(body);
  const publicUrl = urls.find(isOcsPublicLinkUrl);
  const legacyUrl = urls.find(isLegacyOcsStartUrl);
  const retired = urls.find((u) => /\/chatbots\/embed\//.test(u));
  let url = 10;
  const urlNotes: string[] = [];
  if (publicUrl) urlNotes.push(`public link ${publicUrl}`);
  else if (legacyUrl) {
    url = 6;
    urlNotes.push('legacy /start/ URL only');
    auto.push({ severity: 'WARN', message: `handoff carries only the legacy /start/ URL (${legacyUrl}); OCS is removing that page (dimagi/open-chat-studio#4209) — record the /c/<token>/ public link` });
  } else {
    url = 3;
    urlNotes.push(retired ? 'retired /chatbots/embed/ URL' : 'no OCS chat URL');
    auto.push({ severity: 'BLOCKER', message: retired ? `handoff names the retired embed path ${retired} (a 410 stub since OCS #3540)` : 'handoff carries no OCS public chat URL' });
  }
  if (input.chatbot?.public_url && publicUrl && input.chatbot.public_url.replace(/\/+$/, '') !== publicUrl.replace(/\/+$/, '')) {
    auto.push({ severity: 'DRIFT', message: `handoff URL ${publicUrl} ≠ run_state public_url ${input.chatbot.public_url}` });
  }
  const publicId = input.chatbot?.public_id;
  const embedKey = input.chatbot?.embed_key;
  const hasPublicId = publicId ? body.includes(publicId) : /public[_ ]id/i.test(body);
  const hasEmbedKey = embedKey ? body.includes(embedKey) : /embed[_ ]key\W+\S{6,}/i.test(body);
  if (!hasPublicId) { url -= 2; auto.push({ severity: 'WARN', message: 'handoff does not carry the bot\'s public_id' }); }
  if (!hasEmbedKey) { url -= 2; auto.push({ severity: 'WARN', message: 'handoff does not carry a non-empty embed_key' }); }
  const probeTarget = publicUrl ?? legacyUrl;
  if (input.probe === undefined) {
    live = false;
    checks.push({ name: 'public-url-probe', status: 'unable', reason: 'probe skipped (offline / dry-run)' });
    auto.push({ severity: 'INFO-SKIPPED', message: 'live HTTP probe of the public chat URL skipped' });
  } else if (input.probe === null) {
    live = false;
    checks.push({ name: 'public-url-probe', status: 'unable', reason: 'probe failed at grading time (network)' });
    auto.push({ severity: 'PLATFORM', message: `public chat URL probe failed at grading time (${probeTarget ?? 'no URL'})` });
  } else if (probeTarget) {
    checks.push({ name: 'public-url-probe', status: 'checked' });
    const { status, body: page = '' } = input.probe;
    if (status === 503) {
      auto.push({ severity: 'PLATFORM', message: 'public chat URL returned 503 (OCS team web channel disabled / maintenance, OCS #4230) — not a handoff defect (ace#1812)' });
      live = false;
    } else if (status !== 200) {
      url = Math.min(url, 6);
      auto.push({ severity: 'PLATFORM', message: `public chat URL answered HTTP ${status} to an anonymous probe` });
    } else if (NOT_PUBLISHED.test(page)) {
      url = Math.min(url, 6);
      auto.push({ severity: 'WARN', message: 'public chat page renders the "not published / temporarily unavailable" banner' });
    } else {
      auto.push({ severity: 'INFO', message: 'public chat URL fetched OK; the LLO can be sent the link as-is.' });
    }
    urlNotes.push(`probe HTTP ${status}`);
  }

  // ── connect_opp_binding ───────────────────────────────────────────────
  let bind = 10;
  const bindNotes: string[] = [];
  const oppId = input.opportunity?.id ?? (input.opportunity?.url?.match(UUID_RE) ?? [])[0];
  const named = new Set((body.match(UUID_RE) ?? []).map((s) => s.toLowerCase()));
  const oppLinks = [...body.matchAll(/\/opportunity\/([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
  if (!oppId) {
    bind = 7;
    checks.push({ name: 'opp-binding', status: 'unable', reason: 'run_state carries no Connect opportunity id/url to compare' });
    auto.push({ severity: 'INFO-SKIPPED', message: 'opportunity binding not compared: run_state has no connect opportunity' });
  } else {
    checks.push({ name: 'opp-binding', status: 'checked' });
    if (named.has(oppId.toLowerCase())) bindNotes.push(`names opportunity ${oppId}`);
    else if (oppLinks.length) {
      bind = 6;
      auto.push({ severity: 'DRIFT', message: `handoff names opportunity ${oppLinks[0]}, run_state records ${oppId}` });
      bindNotes.push('names a different opportunity');
    } else {
      bind = 4;
      auto.push({ severity: 'BLOCKER', message: `handoff does not name the Connect opportunity this bot is bound to (${oppId})` });
      bindNotes.push('opportunity not named');
    }
  }

  // ── operator_instructions_clarity ─────────────────────────────────────
  let clar = 10;
  const clarNotes: string[] = [];
  const phantom = PHANTOM_PASTE_TARGET.filter((re) => re.test(body));
  if (phantom.length) {
    clar = 3;
    auto.push({ severity: 'BLOCKER', message: 'handoff instructs a paste into a Connect widget field that does not exist (CCC-301 unshipped; ace#1811)' });
    clarNotes.push('phantom paste-in instruction');
  }
  const elements: Array<[string, boolean]> = [
    ['what to do today (share the public chat link)', !!(publicUrl || legacyUrl) && /\b(share|send|open|link)\b/i.test(body)],
    ['how to verify the bot (test prompt + public_id as the run check)', /\b(test|verify|check|confirm)\b/i.test(body) && hasPublicId],
    ['what embed_key / public_id are for (the embed once CCC-301 ships)', /embed[_ ]key/i.test(body) && /(CCC-301|embed)/i.test(body.replace(/embed[_ ]key/gi, ''))],
  ];
  for (const [label, ok] of elements) {
    if (!ok) {
      clar -= 2;
      clarNotes.push(`missing: ${label}`);
      auto.push({ severity: 'WARN', message: `operator instructions missing: ${label}` });
    }
  }
  if (input.clarityResidue) {
    const d = Number(input.clarityResidue.deduction);
    const note = String(input.clarityResidue.note ?? '').trim();
    if (!Number.isFinite(d) || d < 0 || d > 2 || (d > 0 && !note)) {
      throw new Error('clarityResidue.deduction must be 0..2, with a note when non-zero');
    }
    if (d > 0) {
      clar -= d;
      clarNotes.push(`[judgment] readability −${d}: ${note}`);
    }
  }

  // ── credential_hygiene ────────────────────────────────────────────────
  const leaks = findCredentialLeaks(text, input.secretValues);
  let hyg = 10;
  for (const l of leaks) auto.push({ severity: 'BLOCKER', message: `cross-opportunity credential in an LLO-facing doc (${l.rule}: ${l.excerpt})` });
  if (leaks.length) hyg = 1;
  auto.push({ severity: 'INFO', message: 'embed_key is opp-specific (OCS bot-level), not a cross-opportunity credential; team_slug/public_id/link_token are public-by-construction.' });
  auto.push({ severity: 'PLATFORM', message: 'No Connect paste-in exists yet: connect_update_opportunity carries no widget parameter (CCC-301), so the public chat URL is the working route.' });
  checks.push({ name: 'credential-scan', status: 'checked' });

  const dims: Record<string, ScoredDimension> = {
    widget_url_resolves: { score: Math.max(0, url), weight: WIDGET_WEIGHTS.widget_url_resolves, source: 'deterministic', note: urlNotes.join('; ') },
    connect_opp_binding: { score: bind, weight: WIDGET_WEIGHTS.connect_opp_binding, source: 'deterministic', note: bindNotes.join('; ') || 'not compared' },
    operator_instructions_clarity: { score: Math.max(0, clar), weight: WIDGET_WEIGHTS.operator_instructions_clarity, source: 'deterministic', note: clarNotes.join('; ') || 'all three instruction elements present, no phantom paste-in' },
    credential_hygiene: { score: hyg, weight: WIDGET_WEIGHTS.credential_hygiene, source: 'deterministic', note: leaks.length ? `${leaks.length} credential leak(s)` : 'no cross-opportunity credential found' },
  };
  return composeVerdict({
    skill: 'ocs-widget-handoff-eval',
    target: input.target,
    capturePath,
    ranAt: input.ranAt,
    dimensions: dims,
    autoSurfaced: auto,
    checks,
    liveStateVerified: live,
  });
}
