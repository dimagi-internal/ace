#!/usr/bin/env npx tsx
/**
 * Prints the mobile backend a run on THIS machine would use by default —
 * `lease` or `local` — using the same rule as the MCP (env pin, else local iff
 * a provisioned AVD exists). bin/ace-doctor reads it so the Maestro/adb/AVD
 * prerequisites are only demanded where the local backend will actually run.
 */
import { leaseIsDefaultHere } from '../lib/capability-lease-probe.js';

console.log(leaseIsDefaultHere() ? 'lease' : 'local');
