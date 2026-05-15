/**
 * Pure ACE-fingerprint scoring for orphan candidates. Used by per-system
 * sweep skills after the live-set diff has identified candidate orphans;
 * this module decides high / medium / low confidence so the human can
 * triage in chunks.
 *
 * Each system has its own scorer so heuristics can be tuned independently.
 * All scorers return ScoreResult with the same shape; signal strings are
 * surfaced in the orphan report for human review.
 */

import type { Confidence, DriveFolderInfo, LiveSet } from './sweep-types';

const CRISPR_PREFIX = /^CRISPR-/i;
const KEBAB_OPP_NAME = /^[a-z][a-z0-9-]{2,39}$/;
const ACE_NAME_PREFIX = /^(ACE|ace)[-_]/;

export interface ScoreResult {
  confidence: Confidence;
  signals: string[];
}

/**
 * Score a Drive folder. Does NOT do the live-set diff itself — the caller is
 * expected to have already determined this folder is an orphan candidate
 * (i.e. its name does not match an active opp slug). The scorer defensively
 * downgrades to medium if it sees a name that IS in liveSet.oppSlugs in case
 * the caller passed it through.
 */
export function scoreDriveFolder(
  folder: DriveFolderInfo,
  liveSet: LiveSet,
  aceRootFolderId: string,
): ScoreResult {
  const signals: string[] = [];

  if (folder.parentId !== aceRootFolderId) {
    signals.push(`not under ACE root (parent=${folder.parentId})`);
    return { confidence: 'low', signals };
  }

  if (liveSet.oppSlugs.includes(folder.name)) {
    signals.push('name matches an active opp slug');
    return { confidence: 'medium', signals };
  }

  if (CRISPR_PREFIX.test(folder.name)) {
    signals.push('name has CRISPR- prefix (canonical test opp pattern)');
    return { confidence: 'high', signals };
  }

  if (KEBAB_OPP_NAME.test(folder.name)) {
    signals.push('name is kebab-case opp-style (3-40 chars, lowercase)');
    return { confidence: 'high', signals };
  }

  signals.push('under ACE root but does not match a known ACE name pattern');
  return { confidence: 'medium', signals };
}

// ── Connect ───────────────────────────────────────────────────────────

export interface ConnectItemInfo {
  id: string;
  name: string;
  type: 'program' | 'opportunity' | 'payment_unit' | 'invite';
  /** For invites/PUs, the parent opportunity id if known. */
  opportunityId?: string;
  /** From Connect's "active" flag on opportunities. */
  active?: boolean;
}

/**
 * Score a Connect program/opportunity/payment-unit/invite that's been
 * flagged as orphan-candidate by the caller (i.e. its id is not in the
 * relevant live-set bucket). Confidence is driven by name shape — ACE
 * uses CRISPR-* or kebab-case opp names, which differ from the human-typed
 * names real LLOs use.
 */
export function scoreConnectItem(item: ConnectItemInfo, _liveSet: LiveSet): ScoreResult {
  const signals: string[] = [`connect ${item.type}`];

  if (CRISPR_PREFIX.test(item.name)) {
    signals.push('name has CRISPR- prefix');
    return { confidence: 'high', signals };
  }

  if (KEBAB_OPP_NAME.test(item.name)) {
    signals.push('name is kebab-case opp-style');
    return { confidence: 'high', signals };
  }

  if (item.type === 'opportunity' && item.active === false) {
    signals.push('opportunity already inactive (likely ACE-deactivated)');
    return { confidence: 'high', signals };
  }

  signals.push('name does not match a known ACE pattern');
  return { confidence: 'medium', signals };
}

// ── OCS ───────────────────────────────────────────────────────────────

export interface OcsItemInfo {
  id: string;
  name: string;
  type: 'chatbot' | 'collection' | 'pipeline' | 'session' | 'file';
  /** For chatbots, the parent template id if it was cloned. */
  parentChatbotId?: string;
  /** Session-only: whether already soft-closed. */
  isEnded?: boolean;
}

/**
 * Score an OCS chatbot/collection/pipeline/session that's been flagged as
 * orphan-candidate. Strongest signal: chatbot was cloned from ACE's golden
 * template (parentChatbotId matches goldenTemplateId).
 */
export function scoreOcsItem(
  item: OcsItemInfo,
  _liveSet: LiveSet,
  goldenTemplateId: string | null,
): ScoreResult {
  const signals: string[] = [`ocs ${item.type}`];

  if (item.type === 'chatbot' && goldenTemplateId && item.parentChatbotId === goldenTemplateId) {
    signals.push('chatbot cloned from ACE golden template');
    return { confidence: 'high', signals };
  }

  if (CRISPR_PREFIX.test(item.name) || ACE_NAME_PREFIX.test(item.name)) {
    signals.push('name has ACE/CRISPR prefix');
    return { confidence: 'high', signals };
  }

  if (KEBAB_OPP_NAME.test(item.name)) {
    signals.push('name is kebab-case opp-style');
    return { confidence: 'high', signals };
  }

  signals.push('name does not match a known ACE pattern');
  return { confidence: 'medium', signals };
}

// ── CommCare HQ ───────────────────────────────────────────────────────

export interface HqAppInfo {
  id: string;
  name: string;
  domain: string;
}

/**
 * Score an HQ application that's been flagged as orphan-candidate. ACE
 * apps live exclusively in `connect-ace-prod` (or another configured
 * ACE domain), so domain match is the dominant signal.
 */
export function scoreHqApp(item: HqAppInfo, aceHqDomain: string): ScoreResult {
  const signals: string[] = ['hq application'];

  if (item.domain !== aceHqDomain) {
    signals.push(`domain=${item.domain} is not ACE's domain (${aceHqDomain})`);
    return { confidence: 'low', signals };
  }

  signals.push(`in ACE-owned domain ${aceHqDomain}`);

  if (CRISPR_PREFIX.test(item.name) || /Learn|Deliver/.test(item.name)) {
    signals.push('name matches ACE app pattern (Learn/Deliver/CRISPR-)');
    return { confidence: 'high', signals };
  }

  signals.push('name does not match a known ACE pattern');
  return { confidence: 'medium', signals };
}

// ── connect-labs ──────────────────────────────────────────────────────

export interface LabsItemInfo {
  id: string;
  type: 'workflow' | 'pipeline' | 'synthetic' | 'solicitation' | 'fund' | 'review' | 'response';
  name?: string;
  /** If the item references a Connect opportunity, capture it for cross-check. */
  opportunityId?: string;
}

/**
 * Score a labs item that's been flagged as orphan-candidate. ACE is the
 * primary writer to connect-labs, so most items default to high confidence
 * unless they reference an opportunity that's still in the live-set (which
 * would mean the caller mis-classified them as orphans).
 */
export function scoreLabsItem(item: LabsItemInfo, liveSet: LiveSet): ScoreResult {
  const signals: string[] = [`labs ${item.type}`];

  if (item.opportunityId && liveSet.identifiers.connectOpportunityIds.includes(item.opportunityId)) {
    signals.push(`references active opportunity ${item.opportunityId} — likely NOT an orphan`);
    return { confidence: 'low', signals };
  }

  if (item.name && (CRISPR_PREFIX.test(item.name) || ACE_NAME_PREFIX.test(item.name))) {
    signals.push('name has ACE/CRISPR prefix');
    return { confidence: 'high', signals };
  }

  signals.push('ACE is the primary writer to connect-labs; orphan unless proven otherwise');
  return { confidence: 'high', signals };
}
