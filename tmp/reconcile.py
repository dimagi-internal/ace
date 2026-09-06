#!/usr/bin/env python3
"""Reconcile the 2.63.2 selector rows against every harvested 2.64.0 ui-dump."""
import re, glob, yaml, sys, os

EV = 'docs/mobile-atlas/evidence/connect-2.64.0'
dumps = {}
for f in sorted(glob.glob(f'{EV}/*.xml')):
    dumps[os.path.basename(f)[:-4]] = open(f).read()

ids, texts, classes = {}, {}, {}
for label, t in dumps.items():
    for rid in set(re.findall(r'resource-id="([^"]+)"', t)):
        ids.setdefault(rid, []).append(label)
    for tx in set(re.findall(r'text="([^"]+)"', t)):
        if tx.strip(): texts.setdefault(tx, []).append(label)
    for cl in set(re.findall(r'class="([^"]+)"', t)):
        classes.setdefault(cl, []).append(label)

d = yaml.safe_load(open('mcp/mobile/selectors/connect-2.63.2.yaml'))
sel = d['selectors']
seen, unseen = [], []
for k, v in sel.items():
    typ, val = v['type'], v['value']
    hit = None
    if typ == 'id':
        m = re.match(r'^(.*):id/\((.*)\)$', val)   # alternation form
        if m:
            pkg, alts = m.group(1), m.group(2).split('|')
            for a in alts:
                if f'{pkg}:id/{a}' in ids: hit = ids[f'{pkg}:id/{a}']; break
        else:
            hit = ids.get(val)
    elif typ == 'text':
        if '${' in val: hit = None
        else:
            m = re.match(r'^\((.*)\)(.*)$', val)
            if m:
                for a in m.group(1).split('|'):
                    if (a + m.group(2)) in texts: hit = texts[a + m.group(2)]; break
            else:
                hit = texts.get(val)
    elif typ == 'class':
        hit = classes.get(val)
    elif typ in ('point', 'doc'):
        hit = None
    (seen if hit else unseen).append((k, typ, val, hit))

print(f"DUMPS ({len(dumps)}): {', '.join(sorted(dumps))}\n")
print(f"=== OBSERVED LIVE ON 2.64.0 ({len(seen)}) ===")
for k, t, v, h in seen: print(f"  {k:38s} {t:5s} {v[:56]:58s} <- {','.join(h)}")
print(f"\n=== NOT YET OBSERVED ({len(unseen)}) ===")
for k, t, v, h in unseen: print(f"  {k:38s} {t:5s} {v[:56]}")
