import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

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
