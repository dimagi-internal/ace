#!/bin/bash
# Download the CommCare APK for each baked state into the AMI, each one pinned
# by URL and sha256 and checked against Dimagi's signing certificate. Each
# version lands at /opt/ace/apks/<version>/commcare.apk, and 50-states.sh turns
# it into a named state (cc-<version>) in /opt/ace/states.yaml.
#
# COMMCARE_VERSIONS (comma-separated, set by Packer from var.commcare_versions)
# picks which of the pinned versions to bake. A version without a pin below is
# a bake failure, not a download of whatever the URL serves today: adding a
# version means adding its URL and sha256 here, read from the release itself.
#
# The release asset name is not a function of the version (2.62.0 and 2.64.0
# both publish app-commcare-release.apk; some 2.63.x builds used
# commcare-<VER>-release.apk), so each pin carries its full URL.
#
# APK_ROOT / MANIFEST / APKSIGNER / FETCH are overridable so the unit tests can
# run this exact script against a temp dir with a fake download and signer.
set -euo pipefail

: "${COMMCARE_VERSIONS:?COMMCARE_VERSIONS is required}"
APK_ROOT="${APK_ROOT:-/opt/ace/apks}"
MANIFEST="${MANIFEST:-/opt/ace/MANIFEST.txt}"
APKSIGNER="${APKSIGNER:-/usr/local/bin/apksigner}"
FETCH="${FETCH:-curl -fsSL -o}"

# Dimagi, Inc (OU=Mobile Innovations) release signing certificate. Every
# CommCare release APK is signed with it; checked with apksigner on 2.62.0 and
# 2.64.0 (2026-10-14).
DIMAGI_CERT_SHA256=8955dfd80e666306d26d88a4a388a4d9165ac41a7ee1c6788700375593037b03

declare -A APK_URL APK_SHA256
# 2.64.0: the default state (capability.yaml). Live-verified selector map.
APK_URL[2.64.0]=https://github.com/dimagi/commcare-android/releases/download/commcare_2.64.0/app-commcare-release.apk
APK_SHA256[2.64.0]=77c2444bbf36df9cf08028f3720e4d580432a357ed81f722e18d35c8c9f47fdd
# 2.62.0: kept for runs pinned to the older selector map.
APK_URL[2.62.0]=https://github.com/dimagi/commcare-android/releases/download/commcare_2.62.0/app-commcare-release.apk
APK_SHA256[2.62.0]=f088e7cdb0266cbf901ab36d83df815742e04023be13f249ac87f5014afd0f6a
# 2.63.0 is deliberately NOT pinned: it is the crash-loop build (ace#938).

mkdir -p "$APK_ROOT" "$(dirname "$MANIFEST")"
echo "commcare_versions=$COMMCARE_VERSIONS" >>"$MANIFEST"

IFS=',' read -ra VERSIONS <<<"$COMMCARE_VERSIONS"
for VERSION in "${VERSIONS[@]}"; do
  VERSION="${VERSION// /}"
  url="${APK_URL[$VERSION]:-}"
  sha="${APK_SHA256[$VERSION]:-}"
  if [[ -z "$url" || -z "$sha" ]]; then
    echo "ERROR: CommCare $VERSION has no pinned URL + sha256 in $0; pin it (or drop it from commcare_versions)" >&2
    exit 22
  fi
  APK_DIR="$APK_ROOT/$VERSION"
  APK_PATH="$APK_DIR/commcare.apk"
  mkdir -p "$APK_DIR"
  echo "=== CommCare $VERSION ==="
  echo "  url=$url"
  # shellcheck disable=SC2086  # FETCH is a command plus its leading args
  $FETCH "$APK_PATH" "$url"
  echo "$sha  $APK_PATH" | sha256sum -c -

  # The signer, from the APK's own signature block (v2/v3, and v1 when
  # present). A matching sha256 already pins the bytes; this proves the bytes
  # are Dimagi's, so a pin edited to a look-alike build cannot pass review
  # by accident.
  certs="$("$APKSIGNER" verify --print-certs "$APK_PATH")"
  if ! grep -Eiq "^Signer #1 certificate SHA-256 digest: ${DIMAGI_CERT_SHA256}\$" <<<"$certs"; then
    echo "ERROR: CommCare $VERSION is not signed by Dimagi's certificate ${DIMAGI_CERT_SHA256}:" >&2
    echo "$certs" >&2
    exit 23
  fi
  if grep -Eq "^Signer #2 " <<<"$certs"; then
    echo "ERROR: CommCare $VERSION has more than one signer" >&2
    exit 23
  fi

  echo "$sha" >"$APK_PATH.sha256"
  echo "  sha256=$sha signer=dimagi"
  echo "commcare_${VERSION}_sha256=$sha" >>"$MANIFEST"
done

if [[ "$(id -u)" == 0 ]] && id ubuntu >/dev/null 2>&1; then
  chown -R ubuntu:ubuntu "$(dirname "$APK_ROOT")"
fi

echo "=== $APK_ROOT tree ==="
find "$APK_ROOT" -maxdepth 2 -type f | sort
