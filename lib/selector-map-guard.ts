import { parse as parseYaml } from 'yaml';

export interface SelectorRow {
  type?: string;
  value?: string;
  purpose?: string;
}

interface SelectorMapDoc {
  apk_version?: string;
  selectors?: Record<string, SelectorRow>;
}

export interface LiveVerifiedViolation {
  selector: string;
  kind: 'mutated' | 'deleted';
  field?: 'type' | 'value';
  before?: string;
  after?: string;
}

const LIVE_VERIFIED = /live-verified/i;

export function isLiveVerified(row: SelectorRow | undefined): boolean {
  return !!row && typeof row.purpose === 'string' && LIVE_VERIFIED.test(row.purpose);
}

/** A row whose `purpose` records a live-device verification is EVIDENCE, not
 *  an opinion — someone stood in front of a device and looked. Overwriting it
 *  with a fresh guess is the exact failure class jjackson/ace#893 documents:
 *  `viewJobCard`'s "absent in Learn" claim was asserted, never observed, and
 *  survived for months because nothing stopped it being written.
 *
 *  Frozen: `type` and `value` (what it matches, and how).
 *  Free: `purpose` (the prose) — documentation must stay improvable, and
 *  connect-2.63.2.yaml:483 currently carries stale prose that needs fixing.
 *  Deleting the row entirely counts as a mutation. */
export function findLiveVerifiedViolations(
  oldYaml: string,
  newYaml: string,
): LiveVerifiedViolation[] {
  // Track parse failure separately from "parsed to no selectors". Conflating
  // them makes an unparseable NEW map look like every Live-verified row was
  // deleted — a false accusation the committer cannot act on. A broken map is
  // a real problem, but it is not evidence of a mutation, and this guard only
  // speaks to mutations. `npm test` catches the malformed map elsewhere.
  // A try/catch alone is NOT enough: `yaml.parse(':::not yaml:::')` does not
  // throw, it returns a string. Without the shape check below, `selectors`
  // reads as undefined and every Live-verified row looks deleted. Verified by
  // executing this function — the try/catch version reported a false deletion.
  const rows = (text: string): { ok: boolean; rows: Record<string, SelectorRow> } => {
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      return { ok: false, rows: {} };
    }
    if (!doc || typeof doc !== 'object') return { ok: false, rows: {} };
    const selectors = (doc as SelectorMapDoc).selectors;
    if (!selectors || typeof selectors !== 'object') return { ok: false, rows: {} };
    return { ok: true, rows: selectors };
  };
  const beforeParse = rows(oldYaml);
  const afterParse = rows(newYaml);
  if (!beforeParse.ok || !afterParse.ok) return [];
  const before = beforeParse.rows;
  const after = afterParse.rows;
  const out: LiveVerifiedViolation[] = [];

  for (const [name, oldRow] of Object.entries(before)) {
    if (!isLiveVerified(oldRow)) continue;
    const newRow = after[name];
    if (!newRow) {
      out.push({ selector: name, kind: 'deleted' });
      continue;
    }
    for (const field of ['type', 'value'] as const) {
      if (oldRow[field] !== newRow[field]) {
        out.push({
          selector: name,
          kind: 'mutated',
          field,
          before: oldRow[field],
          after: newRow[field],
        });
      }
    }
  }
  return out.sort((a, b) => a.selector.localeCompare(b.selector));
}
