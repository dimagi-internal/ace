import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

// runtime.yaml must say WHERE each secret's value comes from, not just that it
// exists. Until 2026-09-06 it named 45 refs and located none of them, so a
// consumer outside this repo (canopy-web's credential importer) had nothing to
// resolve — the mapping lived only in .env.tpl, keyed by env var.
//
// The reason it must be EXPLICIT rather than derived is measured, not
// theoretical. Deriving `op://Agent-Ace/<name>/credential` looks reasonable and
// is what a first draft used. For gog-oauth-client that ref RESOLVES — to a
// different OAuth app in a different GCP project (1064133157164…, the dead `ace`
// client) than the one ACE actually uses (270508200508…, the shared fleet client
// in Canopy-Shared). A convention that silently returns the wrong credential is
// worse than one that fails, and this is the class that broke ACE's mailbox.

const ROOT = join(__dirname, '..', '..')
const runtime = parse(readFileSync(join(ROOT, 'runtime.yaml'), 'utf8'))
const secrets: Array<Record<string, unknown>> = runtime.secrets

const envTpl = new Map<string, string>()
for (const line of readFileSync(join(ROOT, '.env.tpl'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) envTpl.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''))
}

describe('every declared secret says where its value comes from', () => {
  it('each entry carries exactly one source: op, value, or local_only', () => {
    const bad = secrets.filter((s) => {
      const n = ['op', 'value', 'local_only'].filter((k) => k in s).length
      return n !== 1
    })
    expect(bad.map((s) => s.name)).toEqual([])
  })

  it('every op ref is a well-formed op:// reference', () => {
    for (const s of secrets.filter((x) => 'op' in x)) {
      expect(String(s.op), String(s.name)).toMatch(/^op:\/\/[^/]+\/[^/]+\/.+$/)
    }
  })

  it('gog-oauth-client points at the SHARED vault, not the agent vault', () => {
    // The specific trap above. Agent-Ace holds a same-named item carrying a
    // DIFFERENT client; pointing here at Agent-Ace resolves fine and hands ACE
    // an OAuth app its tokens were never minted for.
    const s = secrets.find((x) => x.name === 'gog-oauth-client')
    expect(s?.op).toBe('op://Canopy-Shared/gog-oauth-client/credential')
  })
})

describe('runtime.yaml and .env.tpl cannot drift', () => {
  it('an op-backed secret matches the op:// ref .env.tpl injects', () => {
    for (const s of secrets.filter((x) => 'op' in x && x.env)) {
      const tpl = envTpl.get(String(s.env))
      if (tpl?.startsWith('op://')) expect(tpl, String(s.name)).toBe(s.op)
    }
  })

  it('a literal value matches the literal .env.tpl injects', () => {
    for (const s of secrets.filter((x) => 'value' in x && x.env)) {
      const tpl = envTpl.get(String(s.env))
      if (tpl !== undefined) expect(tpl, String(s.name)).toBe(s.value)
    }
  })

  it('a value: entry is never an op:// ref wearing the wrong key', () => {
    // Quoting a ref (".env.tpl" wraps refs containing spaces) made three EU
    // CommCare secrets read as literals in a first pass of this migration.
    for (const s of secrets.filter((x) => 'value' in x)) {
      expect(String(s.value), String(s.name)).not.toMatch(/^op:\/\//)
    }
  })
})
