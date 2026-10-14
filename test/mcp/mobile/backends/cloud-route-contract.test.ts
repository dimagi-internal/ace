// Every ace-web route cloud.ts calls must exist on ace-web, and every
// query param it sends must be one ace-web reads. The fixture is ace-web's
// own openapi.json, narrowed to /api/mobile. Unit tests mock fetch, so
// before this a client could call `/api/mobile/install-apk` (server:
// `/apk/install`) or put `state` in a JSON body (server: query only) and
// stay green while every live call 404'd or was silently ignored.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const source = fs.readFileSync(path.join(root, 'mcp/mobile/backends/cloud.ts'), 'utf8');
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, 'test/fixtures/ace-web-mobile-routes.json'), 'utf8'),
) as { routes: Record<string, { query: string[]; body: boolean }> };

const serverPaths = new Map<string, string[]>();
for (const [key, spec] of Object.entries(fixture.routes)) {
  serverPaths.set(key.split(' ')[1], spec.query);
}

// Route literals: '/api/mobile/...' or `/api/mobile/jobs/${jobId}`.
function clientRoutes(): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/['`](\/api\/mobile\/[\w\/${}-]+)['`?]/g)) {
    found.add(m[1].replace(/\$\{[^}]+\}/g, '{job_id}'));
  }
  return [...found];
}

describe('cloud.ts ↔ ace-web /api/mobile route contract', () => {
  it('finds the routes it is checking', () => {
    expect(clientRoutes().length).toBeGreaterThan(10);
  });

  it.each(clientRoutes())('%s exists on ace-web', (route) => {
    expect(serverPaths.has(route), `ace-web has no ${route}`).toBe(true);
  });

  it('every withQuery() param is one ace-web reads from the query string', () => {
    const calls = [...source.matchAll(/withQuery\(\s*'([^']+)',\s*\{([^}]*)\}/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const [, route, params] of calls) {
      const keys = [...params.matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
      const allowed = serverPaths.get(route) ?? [];
      for (const k of keys) expect(allowed, `${route} does not read ?${k}`).toContain(k);
    }
  });
});
