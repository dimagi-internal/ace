#!/bin/bash
python3 - "docs/mobile-atlas/evidence/connect-2.64.0/$1.xml" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
for n in re.findall(r'<node[^>]*>',t):
    g=lambda k:(re.search(k+r'="([^"]*)"',n).group(1) if re.search(k+r'="([^"]*)"',n) else '')
    rid,tx,cl,bd,dsc=g('resource-id'),g('text'),g('class'),g('bounds'),g('content-desc')
    if rid.startswith('org.commcare') or tx.strip() or dsc.strip():
        print(f"{rid:58s}|{cl.split('.')[-1]:22s}|{bd:22s}| {tx or dsc}")
PY
