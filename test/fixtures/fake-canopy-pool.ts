/**
 * A fake canopy-web capability broker for the `test-worker` pool capability
 * (ace#2955), coded against the contract canopy-web is building:
 *
 *   POST   /api/capabilities/leases            → ready (+ready_info.slot) or queued (+position)
 *   GET    /api/capabilities/leases/{id}        → the lease (a queued one is promoted when a slot frees)
 *   DELETE /api/capabilities/leases/{id}        → released; frees the slot
 *   GET    /api/capabilities/leases?…           → {leases:[…]}
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

export class FakeCanopyPool {
  slots: string[];
  mode: 'live' | 'undeclared' | 'ungranted' = 'live';
  leases = new Map<string, FakeLease>();
  /** Slot → lease id, for slots held outside this client (other sessions). */
  readonly calls: string[] = [];
  private seq = 0;

  constructor(slots: string[] = ['worker-1', 'worker-2', 'worker-3', 'worker-4']) {
    this.slots = slots;
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
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
      const lease_id = `L${++this.seq}`;
      const slot = this.freeSlot();
      const lease: FakeLease = slot
        ? { lease_id, status: 'ready', ready_info: { slot }, params: { slot } }
        : { lease_id, status: 'queued', position: null, ready_info: {}, params: {} };
      this.leases.set(lease_id, lease);
      this.promote();
      return json(201, lease);
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
    if (method === 'GET') return json(200, lease);
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

/** A pool env with worker-1 (legacy ACE_E2E_*) and worker-2..4 in ACE_E2E_WORKERS. */
export function poolEnv(slots = ['worker-2', 'worker-3', 'worker-4']): NodeJS.ProcessEnv {
  const json: Record<string, unknown> = {};
  for (const s of slots) {
    const n = Number(s.split('-')[1]);
    const phone = `+7426000020${n}`;
    json[s] = { phone, phoneLocal: phone.slice(2), name: `ACE Test ${n}` };
  }
  return {
    ACE_E2E_PHONE: '+74260000201',
    ACE_E2E_PHONE_LOCAL: '4260000201',
    ACE_E2E_COUNTRY_CODE: '+7',
    ACE_E2E_PIN: '1234',
    ACE_E2E_BACKUP_CODE: '123456789012',
    ACE_E2E_NAME: 'ACE Test',
    ACE_E2E_WORKERS: JSON.stringify(json),
  };
}
