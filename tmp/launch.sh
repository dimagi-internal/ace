#!/bin/bash
set -u
export ANDROID_ADB_SERVER_PORT=5038
S=emulator-5554
adb -s $S logcat -c >/dev/null 2>&1
adb -s $S shell am start -W -n org.commcare.dalvik/org.commcare.activities.DispatchActivity 2>&1 | head -12
sleep 12
adb -s $S shell dumpsys activity activities 2>/dev/null | grep -m1 topResumedActivity
adb -s $S logcat -d -t 200 2>/dev/null | grep -iE "FATAL|AndroidRuntime|commcare.*Exception" | head -20
