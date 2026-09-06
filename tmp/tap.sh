#!/bin/bash
set -u
export ANDROID_ADB_SERVER_PORT=5038
S=emulator-5554
adb -s $S shell input tap "$1" "$2" >/dev/null 2>&1
sleep "${4:-6}"
cd /Users/acedimagi/emdash/worktrees/ace-apk-2640 && ./tmp/dump.sh "$3"
