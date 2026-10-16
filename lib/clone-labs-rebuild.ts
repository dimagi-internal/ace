/**
 * lib/clone-labs-rebuild.ts — the pure half of `clone-to-new-workspace` § 4c:
 * rebuild a run's Phase 7 Labs assets in the CLONE's own labs program (ace#3020).
 *
 * Owner, 2026-10-16: "Shouldn't the process be that we create the report in
 * the new prorgam and the synthetic data in the new program by using the
 * templatized reports and just copying the synthetic data?" So Labs is rebuilt
 * the way HQ (4a) and Connect (4b) are — never opened in place. The source
 * run's synthetic opps are not widened to any partner domain.
 *
 * The rebuild COPIES, it does not regenerate (owner, 2026-10-16: the same
 * educators, partners, class records and findings):
 * - data: each partner's synthetic records, copied as-is into a new labs-only
 *   opp in ONE new program (`synthetic_clone_to_labs_only`, which serves the
 *   source's own fixture folder and keeps its generated-data mark). Never
 *   `synthetic_generate_from_manifest` or any clone_generate/profile atom.
 *   BLOCKED until connect-labs#2571: the deployed atom takes no `program_id`,
 *   so the copies cannot share one program — § 4c stops NOT DONE there;
 * - reports: the same report definitions, instantiated from their templates in
 *   the new program with the source definition's configuration copied
 *   (`workflow_get` → `workflow_create_from_template`);
 * - registry: the source record, copied (`semantic_registry_get` →
 *   `semantic_registry_create`), its `deployment.llo_map` retargeted.
 *
 * Then `remapSyntheticProducts` rewrites the target run's
 * `products.synthetic` to the new ids and URLs, and refuses (via `leftover`)
 * to leave any source id behind — a half-remapped block would send a reviewer
 * to the SOURCE dashboards, which they cannot open.
 */
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function asId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface LabsRebuildPartner {
  label: string;
  source_opportunity_id: number;
}

export interface LabsRebuildSource {
  program_id: number;
  partners: LabsRebuildPartner[];
  registry_id: number | null;
  /** What Phase 7 built, so the clone builds the same set (and the remap knows what to expect). */
  has_programme_report: boolean;
  opp_report_count: number;
  history_runs: number;
  has_benchmarks: boolean;
}

/**
 * What the clone must rebuild, read from the SOURCE run's
 * `phases.synthetic-data-and-workflows.products.synthetic`. Throws when the
 * source is not an ace-run cascade (no `cascade.partners`) — a run without
 * Phase 7 Labs assets has nothing for § 4c to rebuild, and a different shape
 * must not be guessed at.
 */
export function labsRebuildSource(runState: unknown): LabsRebuildSource {
  const syn = asRec(asRec(asRec(asRec(asRec(runState).phases)['synthetic-data-and-workflows']).products).synthetic);
  const cascade = asRec(syn.cascade);
  const partners = asArr(cascade.partners)
    .map((p) => ({ label: String(asRec(p).label ?? ''), source_opportunity_id: asId(asRec(p).opportunity_id) }))
    .filter((p): p is LabsRebuildPartner => p.source_opportunity_id !== null);
  const program = asId(cascade.program_id) ?? asId(syn.labs_opp_id);
  if (!partners.length || program === null) {
    throw new Error('the source run records no products.synthetic.cascade.partners / program_id — not an ace-run cascade, nothing to rebuild');
  }
  return {
    program_id: program,
    partners,
    registry_id: asId(asRec(cascade.registry).registry_id),
    has_programme_report: asId(asRec(cascade.programme_report).workflow_id) !== null,
    opp_report_count: asArr(cascade.opp_reports).length,
    history_runs: asArr(asRec(cascade.history).run_ids).length,
    has_benchmarks: asId(cascade.cohort_id) !== null,
  };
}

/** Every Labs id a `products.synthetic` block references — in values, object keys and URLs. */
export function labsIdsIn(products: unknown): Set<number> {
  const out = new Set<number>();
  const ID_KEYS = /^(opportunity_id|labs_opp_id|labs_opportunity_id|labs_synthetic_opp_id|program_id|workflow_id|run_id|registry_id|cohort_id|visits_pipeline_id|pipeline_id|first|last)$/;
  const walk = (node: unknown, key: string | null, parent: string | null): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, key, parent);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/^\d{4,}$/.test(k)) out.add(Number(k));
        walk(v, k, key);
      }
      return;
    }
    if (typeof node === 'number' && key && (ID_KEYS.test(key) || key === 'run_ids')) {
      out.add(node);
    } else if (typeof node === 'string') {
      for (const m of node.matchAll(/(?:workflow\/|run_id=|program_id=|opportunity_id=|source_run=|flw=)(\d{4,})/g)) out.add(Number(m[1]));
    }
    void parent;
  };
  walk(products, null, null);
  return out;
}

/**
 * Rewrite a `products.synthetic` block from source ids to rebuilt ids. `idMap`
 * maps EVERY source Labs id (opps, program, registry, workflows, runs,
 * pipelines, cohort, benchmark publications) to its rebuilt counterpart; labs
 * ids share one integer space, so one flat map is unambiguous. Returns the new
 * block and `leftover` — source ids still referenced after the rewrite (a
 * blocker: § 4c records `clone.labs.status: done` only when it is empty).
 */
export function remapSyntheticProducts(
  products: unknown,
  idMap: ReadonlyMap<number, number> | Record<number, number>,
): { products: unknown; leftover: number[] } {
  const map = idMap instanceof Map ? idMap : new Map(Object.entries(idMap).map(([k, v]) => [Number(k), v as number]));
  const before = labsIdsIn(products);
  const sub = (n: number) => map.get(n) ?? n;
  const subStr = (s: string) =>
    s.replace(/(workflow\/|run_id=|program_id=|opportunity_id=|source_run=|flw=)(\d{4,})/g, (_m, p: string, d: string) => `${p}${sub(Number(d))}`);
  const walk = (node: unknown, key: string | null): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, key));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const nk = /^\d{4,}$/.test(k) ? String(sub(Number(k))) : k;
        out[nk] = walk(v, k);
      }
      return out;
    }
    if (typeof node === 'number' && before.has(node)) return sub(node);
    if (typeof node === 'string') return subStr(node);
    return node;
  };
  const next = walk(products, null);
  const newIds = new Set(map.values());
  const leftover = [...labsIdsIn(next)].filter((id) => before.has(id) && !newIds.has(id)).sort((a, b) => a - b);
  return { products: next, leftover };
}

/**
 * Who can open the rebuilt dashboards. The new labs-only organisation is made a
 * labs WORKSPACE whose LLOs are the clone's own Connect orgs: labs then gives
 * every MEMBER of those Connect orgs the Network Manager role in the workspace
 * — "a workspace replaces all of the rules below with its roles", including
 * `allowed_domains` (connect-labs `labs/synthetic/models.py`
 * `is_accessible_to`, `labs/workspaces.py` rule 3). So a reviewer the release
 * adds to the Connect org as a viewer can open the Labs dashboards with no Labs
 * call, and no allowlist is ever widened.
 *
 * Returns the Connect orgs a labs grant rides on that the workspace does NOT
 * list as LLOs — non-empty means a reviewer granted on Connect still could not
 * open the dashboards.
 */
export function missingWorkspaceLlos(cloneLabs: unknown, connectOrgs: readonly (string | null | undefined)[]): string[] {
  const llos = new Set(asArr(asRec(asRec(cloneLabs).workspace).llos).map((s) => String(s).trim().toLowerCase()));
  return [...new Set(connectOrgs.filter((o): o is string => !!o).map((o) => o.trim().toLowerCase()))].filter((o) => !llos.has(o)).sort();
}
