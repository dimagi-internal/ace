#!/usr/bin/env bash
# Classify the result of `op inject` for the doctor's env_tpl_render probe.
#
# Usage:  classify-op-inject.sh <exit_code> <<< "<stderr text>"
# Echoes exactly one of: ok | auth_skip | unresolvable | unknown
#
# WHY THIS EXISTS (dimagi-internal/ace#1613)
# The probe used to classify with a catch-all `else -> fail`: anything that was
# not rc=0 and did not match a sign-in denylist was asserted to be "an
# unresolvable op:// ref". A transient (network blip, rate limit, session
# timeout) therefore became the run's only FAIL, which flips the whole doctor
# verdict to "BROKEN — ACE will not function" on a machine that is fine. That is
# the same failure shape as the gog_auth bug in ace#1338 (guessing at another
# tool's error vocabulary), pointing the other way: #1338 was a false PASS, this
# was a false FAIL. A preflight verdict that cries wolf is one people route
# around, which defeats the protection #753 added it for.
#
# So we classify on POSITIVE evidence FOR the defect and treat everything else
# as unknown. The unresolvable signatures below were OBSERVED by running
# `op inject` against deliberately broken references on 2026-08-24, not guessed:
#
#   missing item   -> "could not resolve item UUID for item <x>: could not find
#                      item <x> in vault <uuid>"
#   missing field  -> "item '<vault>/<item>' does not have a field '<x>'"
#   malformed ref  -> "invalid secret reference 'op://...': too few '/':
#                      secret references should have at least vault, item and
#                      field specified"
set -uo pipefail

rc="${1:-1}"
stderr="$(cat)"

if [ "$rc" -eq 0 ]; then
  echo "ok"; exit 0
fi

# Not signed in / no such account on this machine — informational, not a config
# defect. A machine without 1Password configured legitimately still runs ACE.
if printf '%s' "$stderr" | grep -qiE 'sign[- ]?in|session|authoriz|not currently|account .* (not found|isn.t)|no account|could not find account'; then
  echo "auth_skip"; exit 0
fi

# Positive signatures for a genuinely unresolvable / malformed reference.
if printf '%s' "$stderr" | grep -qiE "could not resolve item|could not find item .* in vault|does not have a field|invalid secret reference|too few '/'|isn't an item|no such (item|field|vault)"; then
  echo "unresolvable"; exit 0
fi

# Anything else: we do not know what this is, and guessing is what caused #1613.
echo "unknown"
