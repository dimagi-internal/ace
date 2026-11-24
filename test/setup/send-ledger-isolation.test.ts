/**
 * The send ledger (`~/.ace/pending-sends.jsonl`, ace#3426) is real `~/.ace` state, so the test
 * suite must never write to it.
 *
 * `bin/ace-email` appends a record to it before every non-dry-run send, and
 * `bin/ace-pending-sends --check` reads it at every turn close-out. The shim tests run the
 * real shim against a fake `canopy`, and none of them set `ACE_SEND_LEDGER`, so each `npm test`
 * appended its fixture sends (`x@y.z`, `llo@partner.org`, ...) to the machine's REAL ledger.
 * Seen 2026-11-24 on the cloud runner: 90 unacknowledged "sends", most of them test fixtures,
 * which made the close-out check permanently red. A check that is always red tells a turn
 * nothing, so the real unrecorded sends hidden among them went unseen.
 *
 * The fix is in `test/setup/isolate-ace-home-state.ts` (a per-worker temp ledger), so any new
 * shim test is isolated without opting in. This file proves it end to end: it runs the shim
 * through to the send without setting the variable itself.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_LEDGER = path.join(os.homedir(), '.ace', 'pending-sends.jsonl');

describe('send-ledger isolation (ace#3426 ledger, test pollution)', () => {
  it('points ACE_SEND_LEDGER at a temp file, never the real ~/.ace ledger', () => {
    const ledger = process.env.ACE_SEND_LEDGER;
    expect(ledger, 'setup file must set ACE_SEND_LEDGER').toBeTruthy();
    expect(path.resolve(ledger!)).not.toBe(REAL_LEDGER);
    expect(path.resolve(ledger!).startsWith(path.join(os.homedir(), '.ace'))).toBe(false);
  });

  it('a shim send during tests lands in the temp ledger and leaves the real one untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-canopy-ledger-'));
    fs.writeFileSync(path.join(dir, 'canopy'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const body = path.join(dir, 'body.txt');
    fs.writeFileSync(body, 'Hello, a plain body with no links.\n');

    const realBefore = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null;
    const tempBefore = fs.existsSync(process.env.ACE_SEND_LEDGER!)
      ? fs.readFileSync(process.env.ACE_SEND_LEDGER!, 'utf8')
      : '';

    const r = spawnSync(
      'python3',
      [path.join(REPO_ROOT, 'bin', 'ace-email'), '--to', 'ledger-probe@example.invalid', '--subject', 's', '--body-file', body],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    expect(r.status, r.stderr).toBe(0);

    const tempAfter = fs.readFileSync(process.env.ACE_SEND_LEDGER!, 'utf8');
    expect(tempAfter.length).toBeGreaterThan(tempBefore.length);
    expect(tempAfter).toContain('ledger-probe@example.invalid');

    const realAfter = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null;
    expect(realAfter).toBe(realBefore);
  });
});
