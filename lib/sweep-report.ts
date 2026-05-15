/**
 * Pure markdown renderer for sweep orphan reports. Used by every per-system
 * sweep skill (PRs 2-5 add Connect, OCS, HQ, labs). Output is human-readable
 * markdown plus enough structure that a human can copy individual rows or
 * approve in chunks.
 */

import type { Confidence, Orphan, OrphanReport } from './sweep-types';

const ORDER: Confidence[] = ['high', 'medium', 'low'];

const HEADER: Record<Confidence, string> = {
  high: '## High confidence',
  medium: '## Medium confidence',
  low: '## Low confidence',
};

function rowsFor(orphans: Orphan[], tier: Confidence): Orphan[] {
  return orphans.filter((o) => o.confidence === tier);
}

function renderTable(rows: Orphan[]): string {
  const lines: string[] = [
    '| ID | Name | Created | Signals |',
    '|----|------|---------|---------|',
  ];
  for (const o of rows) {
    const signals = o.signals.join('; ').replaceAll('|', '\\|');
    lines.push(`| ${o.id} | ${o.name} | ${o.createdTime} | ${signals} |`);
  }
  return lines.join('\n');
}

export function renderOrphanReport(report: OrphanReport): string {
  const parts: string[] = [];
  parts.push(`# Sweep report — ${report.system}`);
  parts.push('');
  parts.push(`Generated: ${report.generatedAt}`);
  parts.push(`Live set: ${report.liveSetGeneratedAt}`);
  parts.push('');
  parts.push(
    `Totals — high: ${report.totals.high}, medium: ${report.totals.medium}, low: ${report.totals.low}`,
  );
  parts.push('');

  const total = report.totals.high + report.totals.medium + report.totals.low;
  if (total === 0) {
    parts.push('No orphans found.');
    return parts.join('\n') + '\n';
  }

  for (const tier of ORDER) {
    const rows = rowsFor(report.orphans, tier);
    if (rows.length === 0) continue;
    parts.push(HEADER[tier]);
    parts.push('');
    parts.push(renderTable(rows));
    parts.push('');
  }

  return parts.join('\n') + '\n';
}
