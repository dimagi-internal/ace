// ace turn 478487fe on cloud-ec2-live (2026-10-30, canopy-web investigation 18):
// OCS_API_TOKEN was empty in the ace-ocs process, the backend sent `Bearer ` and
// OCS's 401 "Authentication credentials were not provided." read as a refused
// credential. An empty token must fail before the request, naming what is missing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { OcsTokenMissingError } from '../../../mcp/ocs/errors.js';
import { loadTurnEnvFile } from '../../../lib/load-plugin-env.js';

const BASE = 'https://www.openchatstudio.com';
let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});
afterEach(async () => {
  await mockAgent.close();
});

describe('RestBackend with no token', () => {
  it('throws OcsTokenMissingError without sending a request', async () => {
    const backend = new RestBackend({ baseUrl: BASE, token: '', envSources: ['/x/.env'] });
    const err = await backend.listChatbots({}).catch((e) => e);
    expect(err).toBeInstanceOf(OcsTokenMissingError);
    expect(err.message).toContain('OCS_API_TOKEN is empty');
    expect(err.message).toContain('/x/.env');
    expect(err.message).not.toContain('HTTP 401');
  });
});

describe('loadTurnEnvFile', () => {
  it('reads CANOPY_AGENT_ENV_FILE without overriding set values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-turn-env-'));
    const file = path.join(dir, 'env');
    fs.writeFileSync(file, 'OCS_API_TOKEN=from-turn\nOCS_TEAM_SLUG=from-turn\n');
    const env: NodeJS.ProcessEnv = { CANOPY_AGENT_ENV_FILE: file, OCS_TEAM_SLUG: 'kept' };
    expect(loadTurnEnvFile(env)).toBe(file);
    expect(env.OCS_API_TOKEN).toBe('from-turn');
    expect(env.OCS_TEAM_SLUG).toBe('kept');
  });

  it('is a no-op with no turn env file', () => {
    expect(loadTurnEnvFile({})).toBeNull();
  });
});
