#!/bin/bash
# Install the runtime: the boot hook, the AVD runner, and the ace-mobile CLI.
# Runs last so nothing starts during provisioning.
#
# Dropped from ace-web's image, on purpose:
#   - ace-idle-shutdown.{service,timer,sh} and its sudoers entry. A lease
#     machine ends with its lease; the backstops are the boot hook's
#     max-lifetime halt and the stack's idle alarm (both terminate, because the
#     launch template's shutdown behaviour is terminate).
#   - enabling ace-mobile-runner.service. The boot hook starts it once, for the
#     lease's state.
set -euo pipefail

install -m 0644 /tmp/ace-files/ace-mobile-runner.service   /etc/systemd/system/ace-mobile-runner.service
install -m 0644 /tmp/ace-files/ace-capability-boot.service /etc/systemd/system/ace-capability-boot.service
install -m 0755 /tmp/ace-files/ace-emulator-launch         /usr/local/bin/ace-emulator-launch

# The CLI: one stdlib-only module, two entry points. `ace-mobile` is the only
# name on canopy-web's exec allowlist; the boot hook lives in /usr/local/sbin
# and is not a subcommand, so exec cannot reach it.
install -d -m 0755 /usr/local/lib/ace-mobile
install -m 0644 /tmp/ace-cli/ace_mobile.py /usr/local/lib/ace-mobile/ace_mobile.py
cat >/usr/local/bin/ace-mobile <<'EOF'
#!/bin/sh
exec /usr/bin/python3 -I /usr/local/lib/ace-mobile/ace_mobile.py "$@"
EOF
cat >/usr/local/sbin/ace-capability-boot <<'EOF'
#!/bin/sh
exec /usr/bin/python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/ace-mobile"); import ace_mobile; sys.exit(ace_mobile.boot_main())'
EOF
chmod 0755 /usr/local/bin/ace-mobile /usr/local/sbin/ace-capability-boot
install -d -m 0755 /var/tmp/ace-mobile /var/cache/ace-mobile

# Smoke: the CLI must answer in JSON on the image itself.
/usr/local/bin/ace-mobile --version | tee /var/log/ace-mobile-cli-version.log
python3 -c 'import json,sys; d=json.load(open("/var/log/ace-mobile-cli-version.log")); sys.exit(0 if d["ok"] else 1)'

# What was baked, for `ace-mobile diagnose` readers and AMI forensics.
{
  echo "ace_git_sha=${ACE_GIT_SHA:-unknown}"
  echo "cli_version=$(python3 -c 'import json; print(json.load(open("/var/log/ace-mobile-cli-version.log"))["cli_version"])')"
} >> /opt/ace/MANIFEST.txt

systemctl daemon-reload
systemctl enable ace-capability-boot.service
systemctl disable ace-mobile-runner.service 2>/dev/null || true
