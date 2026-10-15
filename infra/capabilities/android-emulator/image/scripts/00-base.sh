#!/bin/bash
# Base packages: JDK 17 (Android cmdline-tools, apksigner), the emulator's
# headless runtime libraries, a pinned + verified AWS CLI v2, and everything the
# later scripts assume is on PATH. Also turns off the background updaters a
# lease machine must not run.
#
# No `apt-get upgrade`: the source AMI is pinned by exact name
# (variables.pkr.hcl source_ami_name), and an upgrade would make the image a
# function of the day it was baked. Security currency comes from bumping that
# pin, deliberately.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

AWSCLI_VERSION=2.37.11
AWSCLI_SHA256=41e1cf5e301ed04ece2ca3c2d8bdf6c3584e8b67292269689cc3e80f97de71ea
# AWS CLI Team signing key. The public key ships in image/keys/aws-cli-team.asc
# (staged to /tmp/ace-keys by the Packer template); it expires 2027-07-01.
AWSCLI_KEY_FPR=FB5DB77FD5C118B80511ADA8A6310ACC4672475C
AWSCLI_KEY_FILE=/tmp/ace-keys/aws-cli-team.asc

apt-get update -y

# Not installed, on purpose: qemu-kvm, libvirt-*, bridge-utils. The Android
# emulator ships its own qemu and only needs /dev/kvm (group kvm, below);
# libvirt added a daemon, a bridge and a group to every boot for nothing.
apt-get install -y --no-install-recommends \
  ca-certificates curl wget unzip jq gnupg \
  cpu-checker \
  openjdk-17-jdk-headless \
  python3 \
  systemd-timesyncd \
  `# Headless Android emulator runtime deps. -no-window skips the GUI` \
  `# but swiftshader/vulkan still link X11 + GL libs, and the emulator` \
  `# segfaults at startup if any are missing (verified on 2026-05-09:` \
  `# 'Could not open libX11-xcb.so.1, give up' SIGSEGV).` \
  libx11-6 libx11-xcb1 libxext6 libxkbcommon0 \
  libgl1 libpulse0 libnss3

# ── AWS CLI v2, pinned and verified (sha256 AND the AWS CLI Team signature) ──
# Ubuntu 24.04's apt no longer carries `awscli`. Used at runtime by ace-mobile
# (inputs from and artifacts to the stack's bucket) and by the boot hook.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o "$work/awscliv2.zip"
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip.sig" -o "$work/awscliv2.sig"
echo "${AWSCLI_SHA256}  $work/awscliv2.zip" | sha256sum -c -
export GNUPGHOME="$work/gnupg"
install -d -m 0700 "$GNUPGHOME"
key_fpr="$(gpg --batch --with-colons --show-keys "$AWSCLI_KEY_FILE" | awk -F: '$1 == "fpr" {print $10; exit}')"
[[ "$key_fpr" == "$AWSCLI_KEY_FPR" ]] || { echo "ERROR: $AWSCLI_KEY_FILE is $key_fpr, not $AWSCLI_KEY_FPR" >&2; exit 1; }
gpg --batch --quiet --import "$AWSCLI_KEY_FILE"
# VALIDSIG from the pinned primary key is the check; gpg's trust model (an
# uncertified key prints a warning) is not consulted.
gpg --batch --status-fd 1 --verify "$work/awscliv2.sig" "$work/awscliv2.zip" 2>/dev/null \
  | grep -Eq "^\[GNUPG:\] VALIDSIG .* ${AWSCLI_KEY_FPR}\$" \
  || { echo "ERROR: awscli ${AWSCLI_VERSION} signature does not verify against ${AWSCLI_KEY_FPR}" >&2; exit 1; }
unset GNUPGHOME
unzip -q "$work/awscliv2.zip" -d "$work"
"$work/aws/install"
aws --version | tee /var/log/awscli-version.log
grep -q "aws-cli/${AWSCLI_VERSION} " /var/log/awscli-version.log

# ── KVM: informational at bake time ──────────────────────────────────────────
# The bake never boots the emulator (see 50-states.sh). The bake host asks for
# nested virtualization like a lease does, so this line normally reads "KVM
# acceleration can be used"; if it does not, the bake still succeeds and the
# boot hook's own /dev/kvm check is what refuses a lease (reason no-kvm).
kvm-ok 2>&1 | tee /var/log/kvm-ok.log || echo "kvm-ok: no KVM on the bake host (informational only)" | tee -a /var/log/kvm-ok.log

# /dev/kvm belongs to group kvm; the emulator runs as ubuntu.
groupadd -f kvm
usermod -aG kvm ubuntu

# ── Background updaters off ──────────────────────────────────────────────────
# A lease lives minutes to hours and is never patched in place. apt-daily and
# unattended-upgrades otherwise wake on the first boot, take the dpkg lock and
# compete with the emulator's cold boot for CPU and disk.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service \
  unattended-upgrades.service
# snapd stays: the SSM agent that canopy-web's exec rides on is a snap. Hold
# refreshes instead (indefinitely, every snap), so a lease never restarts the
# agent mid-exec.
if command -v snap >/dev/null 2>&1; then
  snap refresh --hold
  snap refresh --time 2>&1 | tee /var/log/snap-refresh-hold.log || true
fi

# /opt/ace is the canonical "stuff baked into this AMI" prefix.
mkdir -p /opt/ace /opt/ace/apks /var/log/ace-mobile

# /var/log/ace-mobile is written to by the emulator (running as ubuntu) and
# the boot hook. Make it ubuntu-owned so redirects don't hit Permission denied.
chown ubuntu:ubuntu /var/log/ace-mobile
# /run/ace-mobile is created on every boot by the tmpfiles rule 60-systemd.sh
# installs (files/ace-mobile.tmpfiles.conf).
