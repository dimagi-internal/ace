#!/usr/bin/env tsx
/**
 * Print the Java executable ACE would use to run commcare-cli.jar, resolved
 * via the SAME `resolveJavaPath()` that lib/commcare-cli-validate.ts uses at
 * runtime — so `bin/ace-doctor`'s commcare_cli_jar check agrees with how the
 * jar actually gets run, instead of doing its own naive `command -v java`
 * probe (which passes for the macOS /usr/bin/java stub even when no working
 * JDK is on PATH, and false-WARNed "stale jar" on Macs with keg-only Homebrew
 * openjdk off PATH).
 *
 * Prints the resolved absolute path to stdout and exits 0 when a working Java
 * is found; prints nothing and exits 1 when none is. No args.
 */

import { resolveJavaPath } from '../lib/commcare-cli-validate.js';

const javaPath = resolveJavaPath();
if (javaPath) {
  process.stdout.write(javaPath);
  process.exit(0);
}
process.exit(1);
