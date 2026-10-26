/**
 * Open a pool lease's sealed slot secrets (canopy-web: canopy-web can no longer
 * read them).
 *
 * canopy-web stores a test worker's PIN and backup code SEALED (`zks1`) to
 * ACE's readers — its approved runner machines and its vault members — and a
 * ready lease hands its holder `slot_data: {public, sealed: {key: "zks1:…"},
 * agent_id}`. Only this machine's device key can open them, which the canopy
 * CLI holds: `canopy vault open-slot-data` reads the lease on stdin and prints
 * `{public, secret}`.
 *
 * An older canopy-web still serves `{public, secret}` in clear; that shape is
 * returned untouched, with no CLI call — so ACE works before and after the
 * canopy-web deploy.
 *
 * The opened values are secrets: nothing here logs them, and a failure names
 * the slot and the CLI's error (which never carries a value), never stdout.
 */
import { spawnSync } from 'node:child_process';
import { MobileError } from '../mcp/mobile/errors.js';
import type { SlotData } from './test-worker-pool.js';

/** The lease fields the CLI needs to bind each sealed value to its name. */
export interface SealedLease {
  lease_id?: string;
  capability?: string;
  slot?: string | null;
  slot_data?: unknown;
}

/** Runs `canopy vault open-slot-data` with `input` on stdin; returns its stdout. */
export type SlotDataOpener = (input: string) => string;

export const OPEN_CMD = ['vault', 'open-slot-data'] as const;

export function canopyOpener(bin = process.env.CANOPY_BIN || 'canopy'): SlotDataOpener {
  return (input: string) => {
    const r = spawnSync(bin, [...OPEN_CMD], { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 20 });
    if (r.error) {
      throw new MobileError(
        'TEST_WORKER_SEALED',
        `could not run \`${bin} ${OPEN_CMD.join(' ')}\`: ${r.error.message}`,
        'Install the canopy CLI (/canopy:setup) — it opens the sealed test-worker secrets with this machine\'s device key.',
      );
    }
    if (r.status !== 0) {
      // canopy's errors never carry a value; stdout (the plaintext) is never shown.
      throw new MobileError(
        'TEST_WORKER_SEALED',
        `\`canopy ${OPEN_CMD.join(' ')}\` failed: ${(r.stderr || '').trim().slice(0, 400)}`,
        'This machine must be an approved runner of ACE (its device key is what the secrets are sealed to). ' +
          'A machine approved after the slot was written cannot open it until the slot is written again ' +
          '(scripts/test-worker-set.ts).',
      );
    }
    return r.stdout;
  };
}

function isSealed(d: unknown): boolean {
  if (!d || typeof d !== 'object') return false;
  const sealed = (d as { sealed?: unknown }).sealed;
  return !!sealed && typeof sealed === 'object' && Object.keys(sealed).length > 0;
}

/**
 * The lease's slot data as `{public, secret}` with plaintext secrets: opened by
 * the canopy CLI when sealed, else as served (the old shape, or null/undefined).
 */
export function openSlotData(
  lease: SealedLease,
  slot: string,
  opener: SlotDataOpener = canopyOpener(),
): SlotData | null | undefined {
  const d = lease.slot_data as SlotData | null | undefined;
  if (!isSealed(d)) return d;
  const out = opener(JSON.stringify({ capability: lease.capability, slot, slot_data: d }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new MobileError(
      'TEST_WORKER_SEALED',
      `\`canopy ${OPEN_CMD.join(' ')}\` for ${slot} printed something that is not JSON`,
      'Update the canopy CLI (/canopy:update): open-slot-data needs canopy ≥ 0.2.800.',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new MobileError('TEST_WORKER_SEALED', `\`canopy ${OPEN_CMD.join(' ')}\` for ${slot} returned no slot data`);
  }
  const p = parsed as SlotData;
  return { public: p.public ?? {}, secret: p.secret ?? {} };
}
