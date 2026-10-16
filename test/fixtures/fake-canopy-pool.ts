/**
 * A fake canopy-web capability broker for the `test-worker` pool capability
 * (ace#2955), coded against the contract canopy-web is building:
 *
 *   POST   /api/capabilities/leases            → ready (+ready_info.slot) or queued (+position)
 *   GET    /api/capabilities/leases/{id}        → the lease (a queued one is promoted when a slot frees)
 *   DELETE /api/capabilities/leases/{id}        → released; frees the slot
 *   GET    /api/capabilities/leases?…           → {leases:[…]}
 *   GET    /api/agents/ace/capabilities/test-worker/slots        → masked slot list
 *   PUT    /api/agents/ace/capabilities/test-worker/slots/{slot} → per-key upsert (null deletes), masked answer
 *   DELETE /api/agents/ace/capabilities/test-worker/slots/{slot} → drops the slot's data
 *
 * A ready lease carries `slot_data: {public, secret}` for its slot (null when
 * the slot has none) — the acquirer's view. `slotDataOnAcquire: false` makes
 * the POST answer omit it, as a broker that fills it only on GET would.
 *
 * `mode: 'undeclared'` answers 422 like a broker with no such capability;
 * `'ungranted'` answers 403 like a workspace that has not granted it.
 */
export interface FakeLease {
  lease_id: string;
  status: string;
  position?: number | null;
  ready_info?: { slot?: string } | null;
  params?: { slot?: string } | null;
  holder?: string;
  created_at?: string;
}

export interface FakeSlotData {
  public: Record<string, string>;
  secret: Record<string, string>;
  updated_at?: string;
  updated_by?: string;
}

/** Complete data for one slot: worker-N → +742600002{0N}, distinct PIN + backup code per slot. */
export function slotDataFor(slot: string): FakeSlotData {
  const n = Number(slot.split('-')[1]);
  const phone = `+742600002${String(n).padStart(2, '0')}`;
  return {
    public: { phone, phoneLocal: phone.slice(2), countryCode: '+7', name: `ACE Test ${n}` },
    secret: { pin: `90${String(n).padStart(2, '0')}`, backupCode: `SECRETBACKUP${String(n).padStart(4, '0')}` },
  };
}

export class FakeCanopyPool {
  slots: string[];
  mode: 'live' | 'undeclared' | 'ungranted' = 'live';
  leases = new Map<string, FakeLease>();
  /** Per-slot data (the credentials). Default: complete, distinct data for every slot. */
  slotData = new Map<string, FakeSlotData>();
  /** False: the acquire answer omits slot_data (the holder's GET carries it). */
  slotDataOnAcquire = true;
  /** False: the slot routes 404, as a canopy-web that predates them. */
  slotRoutes = true;
  /** Every PUT body received, verbatim (tests assert what was SENT). */
  readonly puts: Array<{ slot: string; body: unknown }> = [];
  /** Every lease-acquire POST body received, verbatim (ace#3033). */
  readonly acquires: Array<Record<string, unknown>> = [];
  /** The `x-ace-lease-holder` header on every request, in order ('' when absent). */
  readonly holderHeaders: string[] = [];
  /** Slot → lease id, for slots held outside this client (other sessions). */
  readonly calls: string[] = [];
  private seq = 0;

  constructor(slots: string[] = ['worker-1', 'worker-2', 'worker-3', 'worker-4']) {
    this.slots = slots;
    for (const s of slots) this.slotData.set(s, slotDataFor(s));
  }

  /** The acquirer's view of a lease: a ready one carries its slot's data. */
  private view(l: FakeLease, opts: { withSlotData: boolean }): Record<string, unknown> {
    if (l.status !== 'ready' || !opts.withSlotData) return { ...l };
    const d = this.slotData.get(l.ready_info!.slot!);
    return { ...l, slot_data: d ? { public: { ...d.public }, secret: { ...d.secret } } : null };
  }

  private maskedSlot(slot: string): Record<string, unknown> {
    const d = this.slotData.get(slot);
    const held = [...this.leases.values()].some((l) => l.status === 'ready' && l.ready_info?.slot === slot);
    return {
      slot,
      public: d ? { ...d.public } : {},
      secret_keys: d ? Object.keys(d.secret) : [],
      updated_at: d?.updated_at ?? null,
      updated_by: d?.updated_by ?? null,
      held,
    };
  }

  /** Mark a slot as held by someone else. */
  holdElsewhere(slot: string, holder = 'session=other-laptop'): string {
    const id = `ext-${slot}`;
    this.leases.set(id, {
      lease_id: id,
      status: 'ready',
      ready_info: { slot },
      params: { slot },
      holder,
      created_at: '2026-10-15T05:00:00Z',
    });
    return id;
  }

  freeSlot(): string | null {
    const held = new Set([...this.leases.values()].filter((l) => l.status === 'ready').map((l) => l.ready_info?.slot));
    return this.slots.find((s) => !held.has(s)) ?? null;
  }

  /** Release an external holder and promote the head of the queue. */
  releaseElsewhere(slot: string): void {
    for (const l of this.leases.values()) {
      if (l.ready_info?.slot === slot && l.status === 'ready') l.status = 'released';
    }
    this.promote();
  }

  private promote(): void {
    for (const l of [...this.leases.values()].filter((x) => x.status === 'queued')) {
      const slot = this.freeSlot();
      if (!slot) break;
      l.status = 'ready';
      l.position = null;
      l.ready_info = { slot };
      l.params = { slot };
    }
    let pos = 1;
    for (const l of this.leases.values()) if (l.status === 'queued') l.position = pos++;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    this.holderHeaders.push(new Headers(init?.headers).get('x-ace-lease-holder') ?? '');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const sm = /^\/api\/agents\/ace\/capabilities\/test-worker\/slots(?:\/([^/]+))?$/.exec(url.pathname);
    if (sm) {
      if (!this.slotRoutes) return json(404, { title: 'Not Found', detail: 'Not Found' });
      const slot = sm[1] ? decodeURIComponent(sm[1]) : null;
      if (method === 'GET' && !slot) return json(200, { slots: this.slots.map((s) => this.maskedSlot(s)) });
      if (method === 'PUT' && slot) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { public?: Record<string, string | null>; secret?: Record<string, string | null> };
        this.puts.push({ slot, body });
        const d = this.slotData.get(slot) ?? { public: {}, secret: {} };
        for (const part of ['public', 'secret'] as const) {
          for (const [k, v] of Object.entries(body[part] ?? {})) {
            if (v === null) delete d[part][k];
            else d[part][k] = v;
          }
        }
        d.updated_at = '2026-10-15T12:00:00Z';
        d.updated_by = 'ace';
        this.slotData.set(slot, d);
        return json(200, this.maskedSlot(slot));
      }
      if (method === 'DELETE' && slot) {
        this.slotData.delete(slot);
        return json(200, { slot, deleted: true });
      }
      return json(405, { title: 'method not allowed' });
    }
    const m = /^\/api\/capabilities\/leases(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json(404, { title: 'not found', detail: 'not found' });
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    if (method === 'POST' && !id) {
      if (this.mode === 'undeclared') {
        return json(422, { title: 'ace declares no capability "test-worker"', detail: 'ace declares no capability "test-worker"' });
      }
      if (this.mode === 'ungranted') {
        return json(403, { title: 'no grant', detail: 'workspace connect has no grant for capability test-worker' });
      }
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.acquires.push(sent);
      // canopy-web's pool acquire (canopy_runtime/schema.py resolve_params)
      // takes ONLY an optional `slot` param, and the body is a StrictModel.
      const unknownParams = Object.keys((sent.params as Record<string, unknown>) ?? {}).filter((k) => k !== 'slot');
      const unknownKeys = Object.keys(sent).filter((k) => !['agent', 'capability', 'params', 'turn_id'].includes(k));
      if (unknownParams.length || unknownKeys.length) {
        const said = unknownParams.length
          ? `test-worker: a pool acquire takes only 'slot'; unknown param(s) ${unknownParams.map((k) => `'${k}'`).join(', ')}`
          : `extra fields not permitted: ${unknownKeys.join(', ')}`;
        return json(422, { title: said, detail: said });
      }
      const lease_id = `L${++this.seq}`;
      const slot = this.freeSlot();
      const lease: FakeLease = slot
        ? { lease_id, status: 'ready', ready_info: { slot }, params: { slot } }
        : { lease_id, status: 'queued', position: null, ready_info: {}, params: {} };
      this.leases.set(lease_id, lease);
      this.promote();
      return json(201, this.view(lease, { withSlotData: this.slotDataOnAcquire }));
    }
    if (method === 'GET' && !id) {
      const status = url.searchParams.get('status');
      const rows = [...this.leases.values()].filter((l) =>
        status === 'live' ? ['queued', 'provisioning', 'ready'].includes(l.status) : true,
      );
      return json(200, { leases: rows });
    }
    const lease = id ? this.leases.get(id) : undefined;
    if (!lease) return json(404, { title: 'lease not found', detail: 'lease not found' });
    if (method === 'GET') return json(200, this.view(lease, { withSlotData: true }));
    if (method === 'DELETE') {
      lease.status = 'released';
      this.promote();
      return json(200, lease);
    }
    return json(405, {});
  };

  /** Slots this fake currently counts as held (ready leases). */
  heldSlots(): string[] {
    return [...this.leases.values()].filter((l) => l.status === 'ready').map((l) => l.ready_info!.slot!);
  }
}

/** The legacy ACE_E2E_* worker: the rollout fallback's identity (and nothing else's). */
export function legacyEnv(): NodeJS.ProcessEnv {
  return {
    ACE_E2E_PHONE: '+74260000101',
    ACE_E2E_PHONE_LOCAL: '4260000101',
    ACE_E2E_COUNTRY_CODE: '+7',
    ACE_E2E_PIN: '1234',
    ACE_E2E_BACKUP_CODE: 'LEGACYBACKUP0001',
    ACE_E2E_NAME: 'ACE Test',
  };
}
