#!/usr/bin/env python3
"""Print `export KEY='value'` lines for a dotenv file, safe to `eval`.

The plugin's `.env` is dotenv, not shell: `canopy agent env --plugin ace` writes raw
`KEY=value`, so a value with a space or a shell character (`ACE_E2E_NAME=ACE Test`, a
password with `!`) is a syntax error when the file is `source`d (ace#3372). Values are
quoted with shlex, never evaluated."""
import re
import shlex
import sys

for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key.startswith("export "):
        key = key[len("export "):].strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        continue
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    print(f"export {key}={shlex.quote(value)}")
