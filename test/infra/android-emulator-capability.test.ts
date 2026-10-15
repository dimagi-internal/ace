import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ENVIRONMENT_BASELINE_KEYS } from '../../mcp/mobile/environment-baseline.js'

// The android-emulator capability is declared in four places that must agree,
// and none of them can see the others at runtime:
//   - capability.yaml   (what canopy-web lets an acquire ask for)
//   - image/            (what the machine actually bakes and boots)
//   - stack.params.json (which stack canopy-web reads, which AMI parameter)
//   - runtime.yaml      (what deploy.sh publishes)
// A state in the manifest's enum that the image never baked passes canopy-web's
// validation and then fails on the machine, minutes into a lease, as
// ready.json {ok:false, reason:"unknown-state"}. This file is that check, moved
// to CI.

const ROOT = join(__dirname, '..', '..')
const CAP = join(ROOT, 'infra', 'capabilities', 'android-emulator')
const read = (p: string) => readFileSync(join(CAP, p), 'utf8')

const manifest = parse(read('capability.yaml'))
const params = JSON.parse(read('stack.params.json'))
const runtime = parse(readFileSync(join(ROOT, 'runtime.yaml'), 'utf8'))

function bakedVersions(): string[] {
  const hcl = read('image/variables.pkr.hcl')
  const block = /variable\s+"commcare_versions"\s*\{[\s\S]*?default\s*=\s*\[([^\]]*)\]/.exec(hcl)
  if (!block) throw new Error('commcare_versions default not found in variables.pkr.hcl')
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

describe('android-emulator capability: manifest ↔ image ↔ stack ↔ runtime', () => {
  it('is the spec §1 manifest', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.name).toBe('android-emulator')
    expect(manifest.kind).toBe('ec2-ephemeral')
    expect(manifest.aws).toEqual({ region: 'us-east-1', stack: 'canopy-cap-ace-android-emulator' })
    expect(manifest.exec).toEqual({ allow: ['ace-mobile'] })
  })

  it('offers exactly the states the image bakes, defaulting to the boot default', () => {
    const baked = bakedVersions().map((v) => `cc-${v}`)
    expect(baked.length).toBeGreaterThan(0)
    expect([...manifest.params.state.enum].sort()).toEqual([...baked].sort())
    // 50-states.sh writes `default: cc-<first version>`.
    expect(manifest.params.state.default).toBe(baked[0])
  })

  it('names the same stack, region, owner and capability as stack.params.json', () => {
    expect(params.stack_name).toBe(manifest.aws.stack)
    expect(params.region).toBe(manifest.aws.region)
    expect(params.parameters.Capability).toBe(manifest.name)
    expect(params.parameters.Owner).toBe('ace')
    expect(params.parameters.Mode).toBe('ephemeral')
    expect(params.parameters.NestedVirtualization).toBe('true')
  })

  it('pins canopy\'s template to a release tag, never a branch', () => {
    expect(params.template.repo).toBe('dimagi-internal/canopy-web')
    expect(params.template.ref).toMatch(/^dimagi-canopy-v\d+\.\d+\.\d+$/)
    expect(params.template.path).toBe('sdk/python/src/canopy_sdk/ondemand/assets/ondemand-capability.cfn.yaml')
  })

  it('is declared in runtime.yaml', () => {
    const refs = (runtime.capabilities ?? []).map((c: { manifest: string }) => c.manifest)
    expect(refs).toContain('infra/capabilities/android-emulator/capability.yaml')
    for (const r of refs) expect(existsSync(join(ROOT, r)), r).toBe(true)
  })

  it('puts every allow-listed CLI on PATH in the image', () => {
    const install = read('image/scripts/60-systemd.sh')
    for (const bin of manifest.exec.allow) expect(install).toContain(`/usr/local/bin/${bin}`)
  })

  it('documents every CLI subcommand in the README', () => {
    const cli = read('image/cli/ace_mobile.py')
    const block = /COMMANDS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(cli)
    expect(block).not.toBeNull()
    const subcommands = [...block![1].matchAll(/"([a-z-]+)":\s*cmd_/g)].map((m) => m[1])
    expect(subcommands.length).toBeGreaterThanOrEqual(11)
    const readme = read('README.md')
    for (const s of subcommands) expect(readme, `README is missing \`${s}\``).toContain(`ace-mobile ${s}`)
  })

  it('the mobile playbook points at the README', () => {
    const playbook = readFileSync(join(ROOT, 'playbook', 'integrations', 'mobile-integration.md'), 'utf8')
    expect(playbook).toContain('infra/capabilities/android-emulator/README.md')
  })
})

// Constants the CLI and scripts carry that something else owns. Read from the
// CLI itself (python3 imports the module), never re-typed here.
function cliConstants(): Record<string, unknown> {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ace_mobile', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['ace_mobile'] = m; spec.loader.exec_module(m)
print(json.dumps({k: getattr(m, k) for k in ('DEFAULT_MAX_LIFETIME_S', 'READY_TIMEOUT_S', 'MANIFEST_IDLE_RELEASE_S',
  'DEFAULT_LONGITUDE', 'DEFAULT_LATITUDE', 'DEFAULT_ALTITUDE', 'DEFAULT_SATELLITES')}
  | {'steps': [[k, list(a)] for k, a in m.BASELINE_STEPS], 'fingerprint': m.baseline_fingerprint()}))
`
  const r = spawnSync('python3', ['-I', '-c', code, join(CAP, 'image', 'cli', 'ace_mobile.py')], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

describe('android-emulator: the CLI and scripts agree with what owns each value', () => {
  const c = cliConstants()

  it('boot-hook limits are capability.yaml limits', () => {
    expect(c.DEFAULT_MAX_LIFETIME_S).toBe(manifest.limits.max_lease_s)
    expect(c.READY_TIMEOUT_S).toBe(manifest.limits.ready_timeout_s)
    expect(c.MANIFEST_IDLE_RELEASE_S).toBe(manifest.limits.idle_release_s)
    const boot = read('image/files/ace-capability-boot.service')
    const t = Number(/TimeoutStartSec=(\d+)/.exec(boot)![1])
    expect(t).toBeGreaterThan(manifest.limits.ready_timeout_s)
  })

  // The baseline is applied twice in ACE: by the local backend
  // (mcp/mobile/backends/avd.ts applyEnvironmentBaseline) and by the image
  // (ace_mobile.py BASELINE_STEPS, run by ace-emulator-launch before ready).
  // The lease client compares fingerprints; this compares the actual adb argv.
  const avd = readFileSync(join(ROOT, 'mcp', 'mobile', 'backends', 'avd.ts'), 'utf8')
  const body = (fn: string) => {
    const start = avd.indexOf(`async ${fn}(`)
    expect(start, fn).toBeGreaterThan(0)
    return avd.slice(start, avd.indexOf('\n  }\n', start))
  }

  it('applies the local backend\'s baseline keys, values and fingerprint', () => {
    const src = body('applyEnvironmentBaseline')
    const keys = [...ENVIRONMENT_BASELINE_KEYS]
    const steps = c.steps as [string, string[]][]
    expect([...new Set(steps.map(([k]) => k))].sort()).toEqual([...keys].sort())
    expect(c.fingerprint).toBe(createHash('sha1').update([...keys].sort().join('|')).digest('hex').slice(0, 12))
    // Every adb call avd.ts makes, minus `-s <serial>`, with DEFAULT_MOCK_LOCATION substituted.
    const local = [...src.matchAll(/this\.shell\('adb', \[([\s\S]*?)\]\)/g)].map((m) =>
      [...m[1].matchAll(/'[^']*'|[A-Za-z_][\w.()]*/g)]
        .map((x) => x[0])
        .filter((s) => s !== "'-s'" && s !== 'avd.serial')
        .map((s) => {
          const lit = /^'(.*)'$/.exec(s)
          if (lit) return lit[1]
          const loc = /DEFAULT_MOCK_LOCATION\.(\w+)/.exec(s)
          return String({ longitude: c.DEFAULT_LONGITUDE, latitude: c.DEFAULT_LATITUDE, altitude: c.DEFAULT_ALTITUDE, satellites: c.DEFAULT_SATELLITES }[loc![1] as 'longitude'])
        }),
    )
    const image = steps.map(([, argv]) => argv)
    // Numbers: avd.ts String(480) is "480"; the CLI's literal must say the same.
    expect(image.map((a) => a.join(' ')).sort()).toEqual(local.map((a) => a.join(' ')).sort())
  })

  it('the mock location defaults are avd.ts DEFAULT_MOCK_LOCATION', () => {
    const block = /DEFAULT_MOCK_LOCATION = \{([\s\S]*?)\}/.exec(avd)
    // On branches where it moved to environment-baseline.ts, avd.ts re-exports it.
    const src = block ? block[1] : readFileSync(join(ROOT, 'mcp', 'mobile', 'environment-baseline.ts'), 'utf8')
    for (const [k, v] of [['longitude', c.DEFAULT_LONGITUDE], ['latitude', c.DEFAULT_LATITUDE], ['altitude', c.DEFAULT_ALTITUDE], ['satellites', c.DEFAULT_SATELLITES]]) {
      expect(src).toMatch(new RegExp(`${k}: ${v}\\b`))
    }
  })

  it('grants the local backend\'s runtime permissions', () => {
    const local = [...body('grantRuntimePermissions').matchAll(/'(android\.permission\.[A-Z_]+)'/g)].map((m) => m[1])
    expect(local.length).toBe(9)
    const launcher = read('image/files/ace-emulator-launch')
    const arr = /PERMISSIONS=\(([\s\S]*?)\)/.exec(launcher)![1]
    const image = [...arr.matchAll(/(android\.permission\.[A-Z_]+)/g)].map((m) => m[1])
    expect(image).toEqual(local)
  })
})

describe('android-emulator image: supply chain and bake host', () => {
  const pkr = read('image/ace-mobile.pkr.hcl')
  const vars = read('image/variables.pkr.hcl')

  it('bakes on a nested-virtualization m8i with the plugin pinned to the version that supports it', () => {
    expect(pkr).toMatch(/version = "= 1\.8\.3"/)
    expect(pkr).toMatch(/enable_nested_virtualization = true/)
    expect(vars).toMatch(/default\s+=\s+"m8i\.xlarge"/)
    expect(vars).not.toMatch(/c5n\.metal"/)
  })

  // A dual-WAN network egresses from either link per connection; Packer's own
  // one-IP lookup then authorizes the wrong one half the time and the bake dies
  // with "Timeout waiting for SSH" (three in a row on 2026-10-15).
  it('opens bake SSH to every egress IP bake.sh detects, never 0.0.0.0/0', () => {
    const bake = read('bake.sh')
    expect(bake).toMatch(/packer validate [^\n]*-var "ssh_source_cidrs=\$SSH_CIDRS_JSON"/)
    expect(bake).toMatch(/packer build [^\n]*-var "ssh_source_cidrs=\$SSH_CIDRS_JSON"/)
    expect(pkr).toMatch(/temporary_security_group_source_cidrs\s+= length\(var\.ssh_source_cidrs\) > 0 \? var\.ssh_source_cidrs : null/)
    expect(pkr).toMatch(/temporary_security_group_source_public_ip = length\(var\.ssh_source_cidrs\) == 0/)
    expect(vars).toMatch(/c != "0\.0\.0\.0\/0"/)
  })

  it('pins the source AMI by exact name, never a wildcard', () => {
    const name = /variable "source_ami_name"[\s\S]*?default\s+=\s+"([^"]+)"/.exec(vars)![1]
    expect(name).toMatch(/^ubuntu\/images\/hvm-ssd-gp3\/ubuntu-noble-24\.04-amd64-server-\d{8}(\.\d+)?$/)
    expect(pkr).toMatch(/name\s+= var\.source_ami_name/)
  })

  it('tags the AMI with the states it bakes (bake.sh and deploy.sh check it)', () => {
    expect(pkr).toMatch(/"ace:states"\s+= local\.states/)
    expect(pkr).toMatch(/states = join\(",", \[for v in var\.commcare_versions : "cc-\$\{v\}"\]\)/)
    for (const s of ['bake.sh', 'deploy.sh']) expect(read(s), s).toContain('require_ami_states')
  })

  it('verifies every download by sha256 and never upgrades apt', () => {
    for (const f of ['00-base.sh', '10-android-sdk.sh', '30-maestro.sh', '40-commcare-apk.sh']) {
      const src = read(`image/scripts/${f}`)
      expect(src, f).toMatch(/sha256sum -c -/)
      expect(src, f).toMatch(/_SHA256(\[[^\]]+\])?=[0-9a-f]{64}/)
    }
    for (const f of ['00-base.sh', '10-android-sdk.sh', '20-avd.sh', '30-maestro.sh', '40-commcare-apk.sh', '50-states.sh', '60-systemd.sh']) {
      expect(read(`image/scripts/${f}`), f).not.toMatch(/^[^\n#]*apt-get (dist-)?upgrade/m)
    }
    const base = read('image/scripts/00-base.sh')
    expect(base).toContain('AWSCLI_KEY_FPR=FB5DB77FD5C118B80511ADA8A6310ACC4672475C')
    expect(read('image/keys/aws-cli-team.asc')).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    expect(read('image/scripts/40-commcare-apk.sh')).toContain(
      'DIMAGI_CERT_SHA256=8955dfd80e666306d26d88a4a388a4d9165ac41a7ee1c6788700375593037b03',
    )
  })

  it('every baked CommCare version has a pin, and 2.63.0 (ace#938) is gone', () => {
    const apk = read('image/scripts/40-commcare-apk.sh')
    for (const v of bakedVersions()) expect(apk).toMatch(new RegExp(`APK_SHA256\\[${escapeRegExp(v)}\\]=[0-9a-f]{64}`))
    expect(bakedVersions()).not.toContain('2.63.0')
    expect(bakedVersions()[0]).toBe('2.64.0')
  })
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
