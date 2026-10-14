/**
 * Pure planning + read-back helpers for CommCare HQ "Organization Levels"
 * (`LocationType`) — the half of location-based case sharing that neither Nova
 * nor HQ's REST API can write.
 *
 * ## Contracts, read off HQ + Nova source (2026-10-14)
 *
 * - **Levels have no write API.** `locations/resources/v0_5.py::LocationTypeResource`
 *   allows GET only (Nova's own `lib/commcare/hq/locations.ts` says the same and
 *   so leaves levels as a setup instruction). The only writer is the
 *   Organization Levels page, `LocationTypesView.post`, which takes a hidden
 *   form field `json` = `{"loc_types": [...]}`.
 * - **That POST is a FULL REPLACE.** `remove_old_location_types(pks)` deletes
 *   every existing level whose pk is absent from the payload (and refuses only
 *   when the level already holds locations). A caller that sent just the levels
 *   it cares about would delete every other level on a shared project space.
 *   {@link planLevelsPayload} therefore starts from the levels the page
 *   currently renders and round-trips them verbatim — it can add and amend a
 *   level, never drop one.
 * - **Every payload entry needs all of** `name, parent_type, administrative,
 *   shares_cases, view_descendants, pk, expand_view_child_data_to, has_users`
 *   (`VALID_LOCATION_TYPE_PROPERTIES`) plus the sync-boundary keys read in
 *   `_attach_sync_boundaries_to_location_type` (`expand_from, expand_from_root,
 *   expand_to, include_without_expanding, include_only`). New levels carry a
 *   `fake-pk-N` string pk; `parent_type` of a new level may name another new
 *   level by its fake pk.
 * - **Meaning of the flags.** `shares_cases` is the page's "Owns cases" — a
 *   location of this level gets a case-sharing group, so a worker assigned to
 *   it receives `commcare_primary_case_sharing_id`. `view_descendants` is
 *   "view child data": a worker assigned at this level also receives cases
 *   owned by locations below it; `expand_view_child_data_to` bounds how far
 *   down (must be a strict descendant, checked server-side).
 *
 * `shares_cases` / `view_descendants` map from Nova's per-level `caseFlow`
 * (`ownsCases` → shares_cases; `descendantCases` all|down-to → view_descendants
 * [+ expand_view_child_data_to]) by NAME — Nova's published guide describes the
 * semantics in those words but ACE has not yet watched one HQ project space
 * round-trip it. See `playbook/integrations/hq-case-sharing.md`.
 */

/** What a caller wants a level to be. Identity is the `code`. */
export interface WantedLevel {
  code: string;
  name: string;
  /** Code of the level above, or null for a top-level level. */
  parent_code: string | null;
  /** HQ `shares_cases` ("Owns cases"). */
  owns_cases: boolean;
  /** HQ `view_descendants` ("view child data"). */
  view_descendants: boolean;
  /** Bound for view_descendants — code of a strict descendant level. Omit for unbounded. */
  view_descendants_down_to_code?: string | null;
  /** HQ `has_users` ("Has users"). Defaults to true, as HQ's own UI does for new levels. */
  has_users?: boolean;
}

/** One level exactly as the Organization Levels page embeds it (`initial_page_data location_types`). */
export interface PageLevel {
  pk: number | string;
  name: string;
  parent_type: number | string | null;
  administrative: boolean;
  shares_cases: boolean;
  view_descendants: boolean;
  code: string;
  expand_from: number | string | null;
  expand_from_root: boolean;
  expand_to: number | string | null;
  expand_view_child_data_to: number | string | null;
  /** The page renders `has_users` under this name; the POST wants `has_users`. */
  has_users_setting: boolean;
  include_without_expanding: number | string | null;
  include_only: Array<number | string>;
}

/** One entry of the POST body's `loc_types`. */
export interface LevelPayloadEntry {
  pk: number | string;
  name: string;
  parent_type: number | string | null;
  administrative: boolean;
  shares_cases: boolean;
  view_descendants: boolean;
  code: string;
  expand_from: number | string | null;
  expand_from_root: boolean;
  expand_to: number | string | null;
  expand_view_child_data_to: number | string | null;
  has_users: boolean;
  include_without_expanding: number | string | null;
  include_only: Array<number | string>;
}

export interface LevelsPlan {
  payload: { loc_types: LevelPayloadEntry[] };
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Levels already on the space that the plan leaves exactly as found. */
  preserved: string[];
}

function roundTrip(l: PageLevel): LevelPayloadEntry {
  return {
    pk: l.pk,
    name: l.name,
    parent_type: l.parent_type ?? null,
    administrative: l.administrative,
    shares_cases: l.shares_cases,
    view_descendants: l.view_descendants,
    code: l.code,
    expand_from: l.expand_from ?? null,
    expand_from_root: l.expand_from_root === true,
    expand_to: l.expand_to ?? null,
    expand_view_child_data_to: l.expand_view_child_data_to ?? null,
    has_users: l.has_users_setting !== false,
    include_without_expanding: l.include_without_expanding ?? null,
    include_only: l.include_only ?? [],
  };
}

/**
 * Plan the full-replace POST body that brings `wanted` into existence without
 * deleting anything. Throws on anything HQ would refuse or that would be
 * ambiguous — a failed plan costs nothing, a half-applied replace costs a
 * project space's levels.
 */
export function planLevelsPayload(existing: PageLevel[], wanted: WantedLevel[]): LevelsPlan {
  const codes = wanted.map((w) => w.code);
  if (new Set(codes).size !== codes.length) throw new Error('levels: duplicate `code` in the wanted set');
  const names = wanted.map((w) => w.name.trim());
  if (new Set(names).size !== names.length) throw new Error('levels: duplicate `name` in the wanted set');
  for (const w of wanted) {
    if (!/^[a-zA-Z_][-a-zA-Z0-9_]*$/.test(w.code)) {
      throw new Error(`levels: code "${w.code}" must be a slug (letters, digits, _ or -, not starting with a digit)`);
    }
  }

  const byCode = new Map(existing.map((e) => [e.code, e]));
  const entries = new Map<string, LevelPayloadEntry>(existing.map((e) => [e.code, roundTrip(e)]));
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  // Pass 1 — make sure every wanted level has an entry (and so a pk to refer to).
  let fake = 0;
  for (const w of wanted) {
    if (entries.has(w.code)) continue;
    const clash = existing.find((e) => e.name.trim().toLowerCase() === w.name.trim().toLowerCase());
    if (clash) {
      throw new Error(
        `levels: wanted level "${w.code}" is named "${w.name}", which the space already uses for level code "${clash.code}". ` +
          `HQ requires unique names — rename one, or use code "${clash.code}".`,
      );
    }
    entries.set(w.code, {
      pk: `fake-pk-${++fake}`,
      name: w.name.trim(),
      parent_type: null,
      administrative: true,
      shares_cases: false,
      view_descendants: false,
      code: w.code,
      expand_from: null,
      expand_from_root: false,
      expand_to: null,
      expand_view_child_data_to: null,
      has_users: true,
      include_without_expanding: null,
      include_only: [],
    });
    created.push(w.code);
  }

  const pkOf = (code: string, what: string): number | string => {
    const e = entries.get(code);
    if (!e) throw new Error(`levels: ${what} "${code}" is neither wanted nor already on the space`);
    return e.pk;
  };

  // Pass 2 — apply the wanted fields.
  for (const w of wanted) {
    const e = entries.get(w.code)!;
    const before = JSON.stringify(e);
    e.name = w.name.trim();
    e.parent_type = w.parent_code === null ? null : pkOf(w.parent_code, `parent of "${w.code}"`);
    e.shares_cases = w.owns_cases;
    e.view_descendants = w.view_descendants;
    e.has_users = w.has_users ?? e.has_users;
    if (w.view_descendants_down_to_code) {
      if (!w.view_descendants) {
        throw new Error(`levels: "${w.code}" bounds view_descendants but view_descendants is false`);
      }
      e.expand_view_child_data_to = pkOf(w.view_descendants_down_to_code, `view_descendants_down_to_code of "${w.code}"`);
    } else if (!w.view_descendants) {
      e.expand_view_child_data_to = null;
    }
    if (!byCode.has(w.code)) continue; // already counted as created
    (JSON.stringify(e) === before ? unchanged : updated).push(w.code);
  }

  // Structure checks HQ would otherwise raise as a half-applied save.
  const byPk = new Map([...entries.values()].map((e) => [e.pk, e]));
  for (const e of entries.values()) {
    const seen = new Set<number | string>([e.pk]);
    for (let p = e.parent_type; p !== null && p !== undefined; p = byPk.get(p)?.parent_type ?? null) {
      if (seen.has(p)) throw new Error(`levels: parent cycle through "${e.code}"`);
      seen.add(p);
    }
  }
  for (const e of entries.values()) {
    if (e.expand_view_child_data_to === null || e.expand_view_child_data_to === undefined) continue;
    let isBelow = false;
    for (let p = byPk.get(e.expand_view_child_data_to)?.parent_type ?? null; p !== null; p = byPk.get(p)?.parent_type ?? null) {
      if (p === e.pk) { isBelow = true; break; }
    }
    if (!isBelow) {
      throw new Error(
        `levels: "${e.code}" bounds child data at "${byPk.get(e.expand_view_child_data_to)?.code}", which is not below it ` +
          `(HQ answers "Inconsistency in View Child Data").`,
      );
    }
  }

  const wantedSet = new Set(codes);
  return {
    payload: { loc_types: [...entries.values()] },
    created,
    updated,
    unchanged,
    preserved: existing.filter((e) => !wantedSet.has(e.code)).map((e) => e.code),
  };
}

/** A level as the REST list (`/api/v0.5/location_type/`) reports it. */
export interface ApiLevel {
  id: string | number;
  name: string;
  code: string;
  /** Resource URI of the parent level, or null/"" at the top. */
  parent: string | null;
  shares_cases: boolean;
  view_descendants: boolean;
}

/** Parent level code from a REST row, via the pk embedded in its resource URI. */
export function apiParentCode(row: ApiLevel, all: ApiLevel[]): string | null {
  if (!row.parent) return null;
  const pk = row.parent.match(/\/(\d+)\/?$/)?.[1];
  if (!pk) return null;
  return all.find((l) => String(l.id) === pk)?.code ?? null;
}

/**
 * Compare what was wanted against a FRESH REST read. Empty array = every wanted
 * level is present with the wanted parent and flags. The POST's own status
 * proves nothing (a 200 is the form re-rendering with an error banner).
 */
export function classifyLevelReadback(wanted: WantedLevel[], actual: ApiLevel[]): string[] {
  const problems: string[] = [];
  for (const w of wanted) {
    const a = actual.find((l) => l.code === w.code);
    if (!a) { problems.push(`${w.code}: absent after the save`); continue; }
    const parent = apiParentCode(a, actual);
    if (parent !== w.parent_code) problems.push(`${w.code}: parent is ${parent ?? 'none'}, wanted ${w.parent_code ?? 'none'}`);
    if (a.shares_cases !== w.owns_cases) problems.push(`${w.code}: shares_cases is ${a.shares_cases}, wanted ${w.owns_cases}`);
    if (a.view_descendants !== w.view_descendants) problems.push(`${w.code}: view_descendants is ${a.view_descendants}, wanted ${w.view_descendants}`);
  }
  return problems;
}

/**
 * HQ's user PUT takes `primary_location` + `locations` TOGETHER or not at all
 * (`user_updates.py::_validate_locations`: "Both primary_location and locations
 * must be provided together"), and an omitted pair is a no-op rather than a
 * wipe (`_update_location` returns when both are None) — so the existing
 * `commcare_update_user_field`, which PUTs only `user_data`, leaves a worker's
 * places alone. An empty pair, by contrast, REMOVES every assignment.
 */
export function buildLocationAssignment(primary: string, assigned?: string[]): { primary_location: string; locations: string[] } {
  if (!primary) throw new Error('locations: primary location id is required (an empty pair would REMOVE every assignment)');
  const all = [...new Set([primary, ...(assigned ?? [])])];
  return { primary_location: primary, locations: all };
}
