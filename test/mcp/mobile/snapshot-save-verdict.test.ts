import { describe, expect, it } from 'vitest';

import { snapshotSaveSucceeded } from '../../../mcp/mobile/backends/avd.js';

// ace#2545. `adb emu avd snapshot save` exits 0 whether or not the emulator
// saved: the console answers `OK` or `KO: <reason>`. The verdict used to fail
// only on the word "error", so a refusal read as `saved: true`.
describe('snapshotSaveSucceeded (ace#2545)', () => {
  it('a KO refusal is not a save — the live -read-only reply, verbatim', () => {
    expect(snapshotSaveSucceeded(0, 'KO: Snapshot save is disabled because "-read-only" was specified')).toBe(false);
  });

  it('an OK reply with exit 0 is a save', () => {
    expect(snapshotSaveSucceeded(0, 'OK')).toBe(true);
  });

  it('a non-zero exit is not a save, whatever it printed', () => {
    expect(snapshotSaveSucceeded(1, 'OK')).toBe(false);
  });

  it('still refuses an error line', () => {
    expect(snapshotSaveSucceeded(0, 'error: device offline')).toBe(false);
  });

  it('does not mistake a word merely CONTAINING "ko" for a refusal', () => {
    expect(snapshotSaveSucceeded(0, 'OK\nsnapshot "kokoro" saved')).toBe(true);
  });
});
