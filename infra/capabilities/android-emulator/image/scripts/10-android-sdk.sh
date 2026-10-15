#!/bin/bash
# Install the Android SDK cmdline-tools (pinned + sha256), then use sdkmanager
# to fetch platform-tools, emulator, build-tools and the API 34 google_apis
# x86_64 system image. Lives entirely under /opt/android-sdk.
#
# sdkmanager verifies each package against the checksum in Google's signed
# repository manifest, but always takes the CURRENT revision of `emulator`,
# `platform-tools` and the system image; there is no way to ask it for an old
# one. So what was actually installed is recorded in /opt/ace/MANIFEST.txt
# (`sdkmanager --list_installed`), which `ace-mobile diagnose` readers and AMI
# forensics can compare between bakes.
set -euo pipefail

ANDROID_SDK_ROOT=/opt/android-sdk
CMDLINE_TOOLS_VERSION=11076708 # Sept 2024 stable; matches Android Studio Hedgehog+
CMDLINE_TOOLS_SHA256=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
SYSTEM_IMAGE="system-images;android-34;google_apis;x86_64"
BUILD_TOOLS_VERSION=34.0.0

mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" -o "$work/cmdline-tools.zip"
echo "${CMDLINE_TOOLS_SHA256}  $work/cmdline-tools.zip" | sha256sum -c -
unzip -q "$work/cmdline-tools.zip" -d "$work"
rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/latest"
mv "$work/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest"

cat >/etc/profile.d/android-sdk.sh <<'EOF'
export ANDROID_SDK_ROOT=/opt/android-sdk
export ANDROID_HOME=/opt/android-sdk
export PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator
EOF
chmod 0644 /etc/profile.d/android-sdk.sh
# shellcheck disable=SC1091
source /etc/profile.d/android-sdk.sh

# Accept all licenses up-front (otherwise sdkmanager prompts). `yes`
# gets SIGPIPE'd (exit 141) when sdkmanager closes its stdin after
# the last license is accepted; with set -o pipefail that aborts the
# script. Disable pipefail for this one command — the only exit code
# we care about is sdkmanager's.
set +o pipefail
yes | sdkmanager --licenses >/dev/null
set -o pipefail

# `platforms;android-34` is kept although nothing compiles here: the emulator
# validates its SDK root by looking for platforms/ next to platform-tools/, and
# saving ~60 MB is not worth a bake that might fail on it.
sdkmanager \
  "platform-tools" \
  "emulator" \
  "platforms;android-34" \
  "build-tools;${BUILD_TOOLS_VERSION}" \
  "$SYSTEM_IMAGE"

# `ace-mobile install-apk` reads the package id + version with `aapt dump
# badging`; 40-commcare-apk.sh checks each APK's signer with apksigner. Both
# come from build-tools, on fixed paths.
ln -sf "$ANDROID_SDK_ROOT/build-tools/${BUILD_TOOLS_VERSION}/aapt" /usr/local/bin/aapt
ln -sf "$ANDROID_SDK_ROOT/build-tools/${BUILD_TOOLS_VERSION}/apksigner" /usr/local/bin/apksigner
aapt version
apksigner --version

mkdir -p /opt/ace
{
  echo "cmdline_tools=${CMDLINE_TOOLS_VERSION} sha256=${CMDLINE_TOOLS_SHA256}"
  echo "# sdkmanager --list_installed:"
  sdkmanager --list_installed 2>/dev/null | sed -n '/^ *[a-z].*|/p' | sed 's/^ */sdk: /'
} >>/opt/ace/MANIFEST.txt

# Make the SDK readable by the ubuntu user so the runner service doesn't
# need root.
chown -R ubuntu:ubuntu "$ANDROID_SDK_ROOT"
