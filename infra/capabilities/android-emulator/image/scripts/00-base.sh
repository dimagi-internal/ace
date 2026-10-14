#!/bin/bash
# Base packages: KVM, JDK 17 (required by Android cmdline-tools), and
# everything the later scripts assume is on PATH.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get upgrade -y

apt-get install -y --no-install-recommends \
  ca-certificates curl wget unzip jq \
  qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils \
  cpu-checker \
  openjdk-17-jdk-headless \
  python3 python3-pip \
  systemd-timesyncd \
  `# Headless Android emulator runtime deps. -no-window skips the GUI` \
  `# but swiftshader/vulkan still link X11 + GL libs, and the emulator` \
  `# segfaults at startup if any are missing (verified on 2026-05-09:` \
  `# 'Could not open libX11-xcb.so.1, give up' SIGSEGV).` \
  libx11-6 libx11-xcb1 libxext6 libxkbcommon0 \
  libgl1 libpulse0 libnss3

# AWS CLI v2 — Ubuntu 24.04's apt no longer carries `awscli`, so we
# install the official static bundle. Used at runtime by ace-mobile (inputs
# from and artifacts to the stack's bucket) and by the boot hook (ready.json).
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip
aws --version | tee /var/log/awscli-version.log

# Confirm the bake host exposes KVM. The bake itself never boots the emulator
# (see 50-states.sh), so this proves the packages work, not the runtime: the
# runtime machine's KVM comes from the launch template's nested
# virtualization, and the boot hook refuses to report ready without /dev/kvm.
kvm-ok | tee /var/log/kvm-ok.log

# Make /dev/kvm group-readable and add the ubuntu user so the runtime
# emulator service can use it without root.
groupadd -f kvm
usermod -aG kvm,libvirt ubuntu

# /opt/ace is the canonical "stuff baked into this AMI" prefix.
mkdir -p /opt/ace /opt/ace/apks /var/log/ace-mobile

# /var/log/ace-mobile is written to by the emulator (running as ubuntu) and
# the boot hook. Make it ubuntu-owned so redirects don't hit Permission denied.
chown ubuntu:ubuntu /var/log/ace-mobile

# /run/ace-mobile on every boot: the runner (ubuntu) writes the ready marker,
# active-state and launch-timings there; the boot hook (root) writes
# requested-state and lease.json. (ace-web's image also created an idle
# marker here for its idle-shutdown timer; a lease machine has no such timer.
# It ends with its lease: release, the max-lifetime halt, or the idle alarm.)
cat >/etc/tmpfiles.d/ace-mobile.conf <<'EOF'
d /run/ace-mobile 0755 ubuntu ubuntu -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/ace-mobile.conf
