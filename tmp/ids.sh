#!/bin/bash
# List distinct resource-ids + texts present in a harvested dump.
f="docs/mobile-atlas/evidence/connect-2.64.0/$1.xml"
python3 - "$f" <<'PY'
import sys,re
t=open(sys.argv[1]).read()
ids=sorted(set(re.findall(r'resource-id="([^"]+)"',t)))
print("IDS(%d):"%len(ids))
for i in ids: print("  "+i)
txt=[x for x in sorted(set(re.findall(r'text="([^"]+)"',t))) if x.strip()]
print("TEXTS(%d): %s"%(len(txt), " | ".join(txt[:40])))
PY
