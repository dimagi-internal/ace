/**
 * Read the in-VM `ace-mobile` CLI's argparse contract straight from its source
 * (`build_parser()`): every subcommand, its `--flags`, which are required, and
 * its positional choices. Used by scripts/refresh-lease-contract-fixtures.ts to
 * write test/fixtures/ace-mobile-cli-contract.json, and by
 * test/mcp/mobile/backends/lease-contract.test.ts to prove that fixture is the
 * CLI in this checkout, not a copy of an older one.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface CliContract {
  cli_version: string | null;
  subcommands: Record<string, { flags: string[]; required: string[]; positionals: Record<string, string[] | null> }>;
}

const DUMP_CLI = `
import argparse, importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ace_mobile', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
sys.modules['ace_mobile'] = mod  # dataclasses resolve their module by name
spec.loader.exec_module(mod)
parser = mod.build_parser()
subs = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
out = {}
for name, sp in sorted(subs.choices.items()):
    flags, required, positionals = [], [], {}
    for a in sp._actions:
        if isinstance(a, argparse._HelpAction):
            continue
        if a.option_strings:
            flags += [o for o in a.option_strings if o.startswith('--')]
            if a.required:
                required += [o for o in a.option_strings if o.startswith('--')]
        else:
            positionals[a.dest] = list(a.choices) if a.choices else None
    out[name] = {'flags': sorted(flags), 'required': sorted(required), 'positionals': positionals}
print(json.dumps({'cli_version': getattr(mod, 'CLI_VERSION', None), 'subcommands': out}))
`;

export function dumpCliContract(cliPath: string): CliContract {
  const raw = execFileSync('python3', ['-I', '-c', DUMP_CLI, path.resolve(cliPath)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(raw) as CliContract;
}
