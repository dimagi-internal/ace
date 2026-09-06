#!/bin/bash
# Harvest one ui-dump from the live 2.64.0 device into the evidence dir.
set -u
export ANDROID_ADB_SERVER_PORT=5038
S=emulator-5554
LABEL="$1"
OUT=docs/mobile-atlas/evidence/connect-2.64.0
mkdir -p "$OUT"
adb -s $S shell uiautomator dump /sdcard/d.xml >/dev/null 2>&1
adb -s $S pull /sdcard/d.xml "$OUT/$LABEL.xml" >/dev/null 2>&1
ACT=$(adb -s $S shell dumpsys activity activities 2>/dev/null | grep -m1 "topResumedActivity" | sed -E 's/.*u0 ([^ ]+).*/\1/')
echo "label=$LABEL activity=$ACT bytes=$(wc -c < "$OUT/$LABEL.xml" 2>/dev/null || echo 0)"
