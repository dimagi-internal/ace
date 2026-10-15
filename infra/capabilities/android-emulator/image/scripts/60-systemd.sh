#!/bin/bash
# Install the runtime: the boot hook, the AVD runner, the idle watchdog, the
# /run/ace-mobile tmpfiles rule and the ace-mobile CLI; then prove the units
# parse with `systemd-analyze verify`. Runs last so nothing starts during
# provisioning (units are enabled, never started, here).
#
# Entry points into the one CLI module (/usr/local/lib/ace-mobile/ace_mobile.py):
#   /usr/local/bin/ace-mobile           the CLI. The ONLY name on canopy-web's
#                                       exec allowlist (capability.yaml).
#   /usr/local/sbin/ace-capability-boot the boot hook (boot_main).
#   /usr/local/sbin/ace-idle-watchdog   the idle backstop (idle_main).
#   /usr/local/sbin/ace-launch-plan     snapshot-vs-cold selector the launcher
#                                       asks (launch_plan_main).
# The sbin three are not subcommands, so exec cannot reach them.
#
# Not here, on purpose: ace-web's sudoers entry and its idle-shutdown shell
# script. The idle backstop is now the Python watchdog above, a timer, and
# poweroff (= terminate, per the launch template).
set -euo pipefail

FILES=${FILES:-/tmp/ace-files}
CLI_SRC=${CLI_SRC:-/tmp/ace-cli/ace_mobile.py}

install -m 0644 "$FILES/ace-mobile-runner.service"   /etc/systemd/system/ace-mobile-runner.service
install -m 0644 "$FILES/ace-capability-boot.service" /etc/systemd/system/ace-capability-boot.service
install -m 0644 "$FILES/ace-idle-watchdog.service"   /etc/systemd/system/ace-idle-watchdog.service
install -m 0644 "$FILES/ace-idle-watchdog.timer"     /etc/systemd/system/ace-idle-watchdog.timer
install -m 0644 "$FILES/ace-mobile.tmpfiles.conf"    /etc/tmpfiles.d/ace-mobile.conf
install -m 0755 "$FILES/ace-emulator-launch"         /usr/local/bin/ace-emulator-launch

install -d -m 0755 /usr/local/lib/ace-mobile
install -m 0644 "$CLI_SRC" /usr/local/lib/ace-mobile/ace_mobile.py

# python3 -I: no user site, no PYTHON* env, no cwd on sys.path.
cat >/usr/local/bin/ace-mobile <<'EOF'
#!/bin/sh
exec /usr/bin/python3 -I /usr/local/lib/ace-mobile/ace_mobile.py "$@"
EOF
for entry in boot_main:ace-capability-boot idle_main:ace-idle-watchdog launch_plan_main:ace-launch-plan; do
  fn="${entry%%:*}" name="${entry##*:}"
  cat >"/usr/local/sbin/$name" <<EOF
#!/bin/sh
exec /usr/bin/python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/ace-mobile"); import ace_mobile; sys.exit(ace_mobile.${fn}())' "\$@"
EOF
done
chmod 0755 /usr/local/bin/ace-mobile /usr/local/sbin/ace-capability-boot \
  /usr/local/sbin/ace-idle-watchdog /usr/local/sbin/ace-launch-plan
install -d -m 0755 /var/tmp/ace-mobile /var/cache/ace-mobile

systemd-tmpfiles --create /etc/tmpfiles.d/ace-mobile.conf

# Smoke: every entry point runs on the image itself.
/usr/local/bin/ace-mobile --version | tee /var/log/ace-mobile-cli-version.log
python3 -c 'import json,sys; d=json.load(open("/var/log/ace-mobile-cli-version.log")); sys.exit(0 if d["ok"] else 1)'
/usr/local/sbin/ace-launch-plan "$(awk '/^default:/ {print $2; exit}' /opt/ace/states.yaml)" | grep -Eq '^(cold|snapshot) '

# What was baked, for `ace-mobile diagnose` readers and AMI forensics.
{
  echo "baked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "ace_git_sha=${ACE_GIT_SHA:-unknown}"
  echo "cli_version=$(python3 -c 'import json; print(json.load(open("/var/log/ace-mobile-cli-version.log"))["cli_version"])')"
} >>/opt/ace/MANIFEST.txt

systemctl daemon-reload
# Fails the bake on a unit systemd would only warn about at boot (an option in
# the wrong section, a missing ExecStart binary, a bad timer spec).
systemd-analyze verify \
  /etc/systemd/system/ace-capability-boot.service \
  /etc/systemd/system/ace-mobile-runner.service \
  /etc/systemd/system/ace-idle-watchdog.service \
  /etc/systemd/system/ace-idle-watchdog.timer
systemctl enable ace-capability-boot.service ace-idle-watchdog.timer
# Started only by the boot hook, once, for the lease's state.
systemctl disable ace-mobile-runner.service 2>/dev/null || true
