#!/usr/bin/env node
// Classify a user-scope `nova:` MCP override as the voidcraft-labs/nova-plugin#52
// workaround or as genuine pre-1.1.0 cruft (dimagi-internal/ace#1629).
//
// WHY THIS IS A FUNCTION AND NOT A GREP. `bin/ace-doctor` used to blanket-WARN on
// the mere EXISTENCE of a user-scope `nova:` entry, calling it "stale ... (pre-1.1.0
// setup)" and prescribing `claude mcp remove nova --scope user`. That heuristic
// predates #52 and is now actively harmful: Claude Code 2.1.238 changed what env the
// interactive-session MCP connect path passes to `headersHelper`, Nova's helper is
// env-var dependent, and it silently emits `{}` — no Authorization header at all.
// Measured on spark-facilitator/20260820-0817: 2.1.237 = 32/32 sessions sent a
// header, 2.1.238+ = 0/53. The only working configuration today is a user-scope
// server carrying a STATIC header, which bypasses the helper. Telling the operator
// to delete it returns them to the needs-auth loop that cost that run three
// sessions.
//
// So the discriminator is the presence of a static `Authorization` header, and it is
// worth being a tested pure function rather than a regex buried in a shell branch.
//
// SECRET HANDLING. The input is `claude mcp get nova` output, which contains a live
// PAT. It arrives on STDIN — never argv (visible in `ps`) and never a shell variable
// — and this script prints ONLY the classification token, never any input line.

/**
 * @param {string} mcpGetOutput raw `claude mcp get nova` stdout
 * @returns {'workaround'|'stale'} `workaround` = carries a static Authorization
 *   header (#52 workaround, leave it alone); `stale` = an override with no
 *   credential of its own, which shadows the plugin entry for nothing.
 */
export function classifyNovaUserScopeOverride(mcpGetOutput) {
  const lines = String(mcpGetOutput ?? '').split(/\r?\n/);
  for (const line of lines) {
    // `Authorization:` under the `Headers:` block, with a non-empty value.
    // Case-insensitive: the header name is not case-sensitive on the wire and
    // `claude mcp add --header` echoes back whatever the operator typed.
    const m = /^\s*authorization\s*:\s*(\S.*)$/i.exec(line);
    if (m && m[1].trim() !== '') return 'workaround';
  }
  return 'stale';
}

// CLI: read stdin, print the token. Used by bin/ace-doctor's nova_shell_env probe.
if (import.meta.url === `file://${process.argv[1]}`) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    process.stdout.write(classifyNovaUserScopeOverride(buf) + '\n');
  });
}
