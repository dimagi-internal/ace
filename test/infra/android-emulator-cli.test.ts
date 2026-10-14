import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// The ace-mobile CLI and boot hook (infra/capabilities/android-emulator/image/cli)
// are Python, because they run on the capability machine, which has python3
// and no node. Their unit tests are stdlib unittest against recorded fixtures.
// This file is what puts them in `clean-install`'s unit shards: vitest is the
// only runner CI has, and a Python suite nothing invokes is a suite that is
// silently never run.

const ROOT = join(__dirname, '..', '..')
const CAP = join(ROOT, 'infra', 'capabilities', 'android-emulator')

describe('ace-mobile CLI (python unittest)', () => {
  it('passes', () => {
    const r = spawnSync(
      'python3',
      ['-m', 'unittest', 'discover', '-s', join(CAP, 'image', 'cli', 'tests'), '-t', join(CAP, 'image', 'cli', 'tests')],
      { encoding: 'utf8', timeout: 120_000 },
    )
    if (r.status !== 0) console.error(r.stdout, r.stderr)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    // unittest reports on stderr; make sure tests actually ran.
    expect(r.stderr).toMatch(/Ran [1-9]\d* tests/)
  })
})

describe('capability scripts pass shellcheck', () => {
  const scripts = [
    '_common.sh', 'deploy.sh', 'bake.sh', 'teardown.sh',
    'image/files/ace-emulator-launch',
    'image/scripts/00-base.sh', 'image/scripts/10-android-sdk.sh', 'image/scripts/20-avd.sh',
    'image/scripts/30-maestro.sh', 'image/scripts/40-commcare-apk.sh', 'image/scripts/50-states.sh',
    'image/scripts/60-systemd.sh',
  ]
  const have = spawnSync('shellcheck', ['--version']).status === 0
  // GitHub's ubuntu runners ship shellcheck; on CI its absence is a failure, not
  // a skip, so this check cannot go quietly green.
  it.runIf(have || process.env.CI)('shellcheck -x', () => {
    expect(have, 'shellcheck is not installed on this CI runner').toBe(true)
    const r = spawnSync('shellcheck', ['-x', ...scripts], { cwd: CAP, encoding: 'utf8' })
    if (r.status !== 0) console.error(r.stdout, r.stderr)
    expect(r.status).toBe(0)
  })
})
