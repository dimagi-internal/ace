# _ace-plugin-paths.sh — where the installed ACE plugin and its data dir live.
# Sourced by bin/ace-setup and bin/ace-doctor (not executable on its own).
#
# ACE is installed under more than one marketplace name: `ace@ace` (the repo's
# own marketplace) and `ace@canopy-agents` (the personal catalog canopy's
# `canopy agents connect` registers, canopy#895). Claude Code records it in
# installed_plugins.json as `<plugin>@<marketplace>`, caches it at
# plugins/cache/<marketplace>/<plugin>/<version>/, and gives it the data dir
# plugins/data/<plugin>-<marketplace>/ — PLUGIN FIRST (on disk:
# `context7-claude-plugins-official`). `ace-ace` hid the order for months.
#
# Env overrides: ACE_PLUGIN_REGISTRY (default ~/.claude/plugins/installed_plugins.json).

_ace_registry() {
  printf '%s\n' "${ACE_PLUGIN_REGISTRY:-$HOME/.claude/plugins/installed_plugins.json}"
}

# One field of the registry entry for ACE: `key`, `installPath` or `version`.
# Prefers `ace@ace`, else the first `ace@<marketplace>`. Reads the current
# format ({version: 2, plugins: {...}}) and the older flat one. Empty when node,
# the registry or the entry is missing — callers fall through.
ace_registry_field() {
  _reg="$(_ace_registry)"
  [ -f "$_reg" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const p=(d&&d.plugins)||d||{};const k=p['ace@ace']?'ace@ace':Object.keys(p).find(k=>/^ace@/.test(k));if(!k)process.exit(0);const e=p[k];const v=Array.isArray(e)?e.find(x=>x&&x.installPath)||e[0]:e;const f=process.argv[2];if(f==='key')console.log(k);else if(v&&v[f])console.log(v[f])}catch(_){}" "$_reg" "$1" 2>/dev/null
}

# plugins/data/<plugin>-<marketplace> for a root under plugins/cache/<mp>/<plugin>/<ver>; empty otherwise.
ace_data_dir_from_root() {
  case "$1" in
    */plugins/cache/*/*/*)
      _pre="${1%%/plugins/cache/*}"
      _rest="${1#*/plugins/cache/}"
      _mp="${_rest%%/*}"; _rest="${_rest#*/}"
      _pl="${_rest%%/*}"
      printf '%s/plugins/data/%s-%s\n' "$_pre" "$_pl" "$_mp"
      ;;
  esac
}

# The data dir ACE's MCP servers read .env from. Order:
#   1. $CLAUDE_PLUGIN_DATA (when actually expanded)
#   2. the installed entry in installed_plugins.json: ace@<mp> -> <plugins>/data/ace-<mp>
#   3. derived from the given root's cache path (registry missing)
#   4. ~/.claude/plugins/data/ace-ace
ace_data_dir() {
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ "$CLAUDE_PLUGIN_DATA" != '${CLAUDE_PLUGIN_DATA}' ]; then
    printf '%s\n' "$CLAUDE_PLUGIN_DATA"; return 0
  fi
  _key="$(ace_registry_field key)"
  if [ -n "$_key" ]; then
    printf '%s/data/%s-%s\n' "$(dirname "$(_ace_registry)")" "${_key%%@*}" "${_key#*@}"; return 0
  fi
  _d="$(ace_data_dir_from_root "${1:-}")"
  if [ -n "$_d" ]; then printf '%s\n' "$_d"; return 0; fi
  printf '%s\n' "$HOME/.claude/plugins/data/ace-ace"
}

# Newest cached ACE version dir under any marketplace; empty when none.
ace_newest_cache_root() {
  ls -1d "$HOME"/.claude/plugins/cache/*/ace/*/ 2>/dev/null | sed 's:/$::' | sort -V | tail -1
}
