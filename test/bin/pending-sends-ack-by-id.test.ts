/**
 * `bin/ace-pending-sends --ack` must be able to clear ONE entry that captured no thread and no
 * body fingerprint.
 *
 * `bin/ace-email` records the attempt before it hands off to canopy. A send whose body came from
 * stdin or an inline flag, with no `--thread-id`, leaves an entry whose thread and fingerprint are
 * both empty. `--ack` matched only those two fields, so the entry could be cleared only with
 * `--ack all`, which also clears every real unrecorded send. Seen 2026-11-26 on the cloud runner:
 * a 25 Nov attempt with nothing captured kept the close-out check red after every real send had
 * been recorded. Each entry now carries an id (its send time in whole seconds), printed in the
 * listing and accepted by `--ack`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOL = path.resolve(__dirname, '..', '..', 'bin', 'ace-pending-sends');

function run(ledger: string, ...args: string[]) {
  return spawnSync('python3', [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ACE_SEND_LEDGER: ledger },
  });
}

describe('ace-pending-sends --ack <id>', () => {
  it('clears an uncaptured entry by id and leaves the real unrecorded send pending', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-sends-id-'));
    const ledger = path.join(dir, 'pending-sends.jsonl');
    const blank = { at: 1795604447.35, verb: 'send', thread_id: '', recipients: [], body_fingerprint: '', acknowledged: false };
    const real = { at: 1795604460.66, verb: 'send', thread_id: '1a2125b045ba181c', recipients: [], body_fingerprint: 'f989176f98c2096f', acknowledged: false };
    fs.writeFileSync(ledger, `${JSON.stringify(blank)}\n${JSON.stringify(real)}\n`);

    const listing = run(ledger);
    expect(listing.stdout).toContain('id 1795604447');
    expect(listing.stdout).toContain('(recipients not captured)');

    const ack = run(ledger, '--ack', '1795604447');
    expect(ack.stdout).toContain('acknowledged 1 send(s)');

    const check = run(ledger, '--check');
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('1a2125b045ba181c');
    expect(check.stdout).not.toContain('id 1795604447');
  });
});
