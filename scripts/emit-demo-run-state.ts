// Emit a demo run_state.yaml to stdout. Usage: npx tsx scripts/emit-demo-run-state.ts <demoName> <runId> <denovo|clone|ace-run>
import { buildDemoRunState } from '../lib/demo-run-state.js';
import { stringify } from 'yaml';
const [demoName, runId, source] = process.argv.slice(2);
if (!demoName || !runId || !source) { console.error('usage: emit-demo-run-state <demoName> <runId> <denovo|clone|ace-run>'); process.exit(2); }
process.stdout.write(stringify(buildDemoRunState({ demoName, runId, source: source as any, createdAt: new Date().toISOString() })));
