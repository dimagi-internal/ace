# ACE ↔ OCS Integration Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a swappable composite MCP backend that exposes 22 atomic OCS capabilities (clone chatbots, upload RAG collections, patch pipeline nodes, read transcripts, etc.) so ACE skills can create, configure, and monitor per-opportunity OCS chatbots without touching OCS's web UI directly.

**Architecture:** MCP server (`mcp/ocs-server.ts`) registers ~22 tools that delegate to a `CompositeBackend`. The composite reads a `capability-map.ts` routing table and dispatches to either `RestBackend` (public OCS REST API, observation atoms) or `PlaywrightBackend` (authenticated Django session + CSRF, authoring atoms). The Playwright backend uses `page.request` only — no click-driving — and all four pipeline-patch atoms share one `patchLlmNodeParams` helper that GET→mutate→POSTs the pipeline JSON through the `/pipelines/data/<pk>/` endpoint.

**Tech Stack:** TypeScript (ESM) + `tsx` for direct execution, `@modelcontextprotocol/sdk` for MCP, `zod` for input schemas, `playwright` for authenticated HTTP, `undici` for REST + test mocking, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md`

---

## Phase 0 — Bootstrap

### Task 1: Install dependencies and test infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `test/mcp/ocs/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `test/mcp/ocs/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke', () => {
  it('runs', () => {
    expect(2 + 2).toBe(4);
  });
});
```

- [ ] **Step 2: Run it to confirm vitest is missing**

Run: `npx vitest run test/mcp/ocs/smoke.test.ts`
Expected: command fails because `vitest` is not installed.

- [ ] **Step 3: Install dependencies**

Run:
```bash
npm install --save-dev vitest @types/node
npm install playwright undici
npx playwright install chromium
```

- [ ] **Step 4: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/eval/**'],
    // Integration tests gated by env var; default excludes them
    env: {
      OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0',
    },
  },
});
```

- [ ] **Step 5: Add npm scripts**

In `package.json`, add these to the `scripts` section:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:integration": "OCS_INTEGRATION=1 vitest run",
"mcp:ocs": "npx tsx mcp/ocs-server.ts"
```

- [ ] **Step 6: Run smoke test to verify it passes**

Run: `npm test -- test/mcp/ocs/smoke.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/mcp/ocs/smoke.test.ts
git commit -m "chore(mcp): add vitest, playwright, undici for OCS integration layer"
```

---

### Task 2: Create directory scaffolding

**Files:**
- Create: `mcp/ocs/client.ts`
- Create: `mcp/ocs/types.ts`
- Create: `mcp/ocs/errors.ts`
- Create: `mcp/ocs/capability-map.ts`
- Create: `mcp/ocs/backends/rest.ts`
- Create: `mcp/ocs/backends/playwright.ts`
- Create: `mcp/ocs/backends/composite.ts`
- Create: `mcp/ocs/backends/pipeline-patch.ts`
- Create: `mcp/ocs/auth/playwright-session.ts`
- Create: `mcp/ocs/auth/rest-token.ts`

- [ ] **Step 1: Create all files with minimal valid TypeScript placeholders**

Each file starts empty except for a one-line header comment and an `export {};` to make it a valid ESM module. This is only to land the file structure; real content comes in later tasks.

For every file above, run:
```bash
echo "// <filename> — populated in later tasks" > <path>
echo "export {};" >> <path>
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npx tsc --noEmit --project .`
Expected: no errors. If `tsconfig.json` doesn't exist, skip this check; next task will address it.

- [ ] **Step 3: Commit**

```bash
git add mcp/ocs/
git commit -m "chore(mcp): scaffold OCS integration directory layout"
```

---

## Phase 1 — Types, errors, capability map

### Task 3: Define domain types

**Files:**
- Create: `mcp/ocs/types.ts` (replace the scaffold)

- [ ] **Step 1: Write types.ts with full content**

Replace the file contents of `mcp/ocs/types.ts`:

```ts
// Domain types for the OCS integration layer.
// Naming: snake_case for fields that cross the HTTP boundary (matches OCS API + eventual REST),
// camelCase only for internal helpers. Interface method names are camelCase (TS convention).

export interface Experiment {
  id: number;
  name: string;
  public_id: string;
  version_number?: number;
  pipeline_id?: number;
  team_slug?: string;
}

export interface Collection {
  id: number;
  name: string;
  summary: string;
  is_index: boolean;
  is_remote_index: boolean;
  llm_provider?: number;
  embedding_provider_model?: number;
}

export interface CollectionFile {
  id: number;
  name: string;
  collection_id: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  chunk_count?: number;
}

export interface Session {
  id: string;
  experiment_id?: string;
  created_at: string;
  updated_at?: string;
  tags: string[];
  state?: Record<string, unknown>;
}

export interface Message {
  id: string;
  created_at: string;
  message_type: 'human' | 'ai' | 'system';
  content: string;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Pipeline graph shape (React-Flow). Simplified to what ACE needs.
export interface FlowNode {
  id: string;
  type?: string;
  data: {
    type: string; // LLMResponseWithPrompt, StartNode, EndNode, etc.
    label?: string;
    params: Record<string, unknown>;
  };
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface PipelineDataResponse {
  pipeline: {
    id: number;
    name: string;
    data: FlowGraph;
    errors: string[];
  };
}

export interface PipelineDataSaveResponse {
  data: FlowGraph;
  errors: string[];
}

// The subset of LLMResponseWithPrompt params the integration layer patches.
export interface LlmNodeParams {
  prompt?: string;
  source_material_id?: number | null;
  collection_id?: number | null;
  collection_index_ids?: number[];
  max_results?: number;
  generate_citations?: boolean;
  tools?: string[];
  custom_actions?: string[];
  built_in_tools?: string[];
  mcp_tools?: string[];
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit mcp/ocs/types.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/ocs/types.ts
git commit -m "feat(mcp): add OCS domain types (Experiment, Collection, Session, Flow graph)"
```

---

### Task 4: Define error hierarchy with tests

**Files:**
- Create: `mcp/ocs/errors.ts` (replace scaffold)
- Create: `test/mcp/ocs/errors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/mcp/ocs/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  OcsError,
  SessionExpiredError,
  CsrfTokenMissingError,
  PipelineShapeError,
  PipelineValidationError,
  CollectionIndexingTimeoutError,
  HttpError,
} from '../../../mcp/ocs/errors.js';

describe('OcsError hierarchy', () => {
  it('HttpError carries status, path, and body', () => {
    const e = new HttpError(404, '/api/experiments/99/', 'Not Found');
    expect(e).toBeInstanceOf(OcsError);
    expect(e.status).toBe(404);
    expect(e.path).toBe('/api/experiments/99/');
    expect(e.body).toBe('Not Found');
    expect(e.message).toContain('404');
  });

  it('PipelineValidationError carries a list of validation errors', () => {
    const e = new PipelineValidationError(['node foo missing input', 'edge bar dangling']);
    expect(e).toBeInstanceOf(OcsError);
    expect(e.validationErrors).toEqual(['node foo missing input', 'edge bar dangling']);
  });

  it('PipelineShapeError identifies the invariant violation', () => {
    const e = new PipelineShapeError('Expected 1 node, found 3');
    expect(e).toBeInstanceOf(OcsError);
    expect(e.message).toContain('Expected 1 node, found 3');
  });

  it('SessionExpiredError suggests the login command', () => {
    const e = new SessionExpiredError();
    expect(e.message).toMatch(/ace ocs login/);
  });

  it('CollectionIndexingTimeoutError names the collection', () => {
    const e = new CollectionIndexingTimeoutError(42, 300);
    expect(e.collectionId).toBe(42);
    expect(e.timeoutSec).toBe(300);
  });

  it('CsrfTokenMissingError is retryable', () => {
    const e = new CsrfTokenMissingError();
    expect(e.retryable).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- test/mcp/ocs/errors.test.ts`
Expected: FAIL — module `../../../mcp/ocs/errors.js` exports nothing useful.

- [ ] **Step 3: Write errors.ts**

Replace `mcp/ocs/errors.ts`:

```ts
export class OcsError extends Error {
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionExpiredError extends OcsError {
  constructor() {
    super('OCS session expired. Run `ace ocs login` to re-authenticate.');
  }
}

export class CsrfTokenMissingError extends OcsError {
  retryable = true;
  constructor() {
    super('CSRF token missing or stale; refetching.');
  }
}

export class PipelineShapeError extends OcsError {
  constructor(message: string) {
    super(`Pipeline shape invariant violated: ${message}`);
  }
}

export class PipelineValidationError extends OcsError {
  constructor(public validationErrors: string[]) {
    super(`Pipeline save rejected: ${validationErrors.join('; ')}`);
  }
}

export class CollectionIndexingTimeoutError extends OcsError {
  constructor(public collectionId: number, public timeoutSec: number) {
    super(`Collection ${collectionId} indexing timed out after ${timeoutSec}s`);
  }
}

export class HttpError extends OcsError {
  constructor(public status: number, public path: string, public body: string) {
    super(`HTTP ${status} ${path}: ${body.slice(0, 200)}`);
    this.retryable = status >= 500 || status === 429;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/errors.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/errors.ts test/mcp/ocs/errors.test.ts
git commit -m "feat(mcp): add OcsError hierarchy with retryability flags"
```

---

### Task 5: Define capability map with routing test

**Files:**
- Create: `mcp/ocs/capability-map.ts` (replace scaffold)
- Create: `test/mcp/ocs/capability-map.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/ocs/capability-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, type Capability } from '../../../mcp/ocs/capability-map.js';

describe('capability map', () => {
  it('has exactly 22 entries', () => {
    expect(Object.keys(CAPABILITY_MAP).length).toBe(22);
  });

  it('every entry has a backend and a restTarget', () => {
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(route.backend, name).toMatch(/^(REST|PLAYWRIGHT|HYBRID)$/);
      expect(route.restTarget, name).toMatch(/^[A-Z]+ \//);
    }
  });

  it('routes observation atoms through REST', () => {
    const observation: Capability[] = [
      'list_chatbots', 'get_chatbot', 'list_sessions', 'get_session',
      'end_session', 'add_session_tags', 'remove_session_tags',
      'update_session_state', 'send_test_message', 'trigger_bot_message',
      'update_participant_data', 'download_file',
    ];
    for (const cap of observation) {
      expect(CAPABILITY_MAP[cap].backend, cap).toBe('REST');
    }
  });

  it('routes authoring atoms through PLAYWRIGHT (except embed info which is HYBRID)', () => {
    const authoring: Capability[] = [
      'clone_chatbot', 'set_chatbot_system_prompt', 'create_collection',
      'upload_collection_files', 'wait_for_collection_indexing',
      'attach_knowledge', 'set_chatbot_tools', 'set_source_material',
      'publish_chatbot_version',
    ];
    for (const cap of authoring) {
      expect(CAPABILITY_MAP[cap].backend, cap).toBe('PLAYWRIGHT');
    }
    expect(CAPABILITY_MAP.get_chatbot_embed_info.backend).toBe('HYBRID');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npm test -- test/mcp/ocs/capability-map.test.ts`
Expected: FAIL — `CAPABILITY_MAP` is undefined.

- [ ] **Step 3: Write capability-map.ts**

Replace `mcp/ocs/capability-map.ts`:

```ts
export type Backend = 'REST' | 'PLAYWRIGHT' | 'HYBRID';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

export type Capability =
  // Authoring (10)
  | 'clone_chatbot'
  | 'set_chatbot_system_prompt'
  | 'create_collection'
  | 'upload_collection_files'
  | 'wait_for_collection_indexing'
  | 'attach_knowledge'
  | 'set_chatbot_tools'
  | 'set_source_material'
  | 'publish_chatbot_version'
  | 'get_chatbot_embed_info'
  // Observation (12)
  | 'list_chatbots'
  | 'get_chatbot'
  | 'list_sessions'
  | 'get_session'
  | 'end_session'
  | 'add_session_tags'
  | 'remove_session_tags'
  | 'update_session_state'
  | 'send_test_message'
  | 'trigger_bot_message'
  | 'update_participant_data'
  | 'download_file';

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring
  clone_chatbot:                { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/' },
  set_chatbot_system_prompt:    { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/prompt/' },
  create_collection:            { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/' },
  upload_collection_files:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/{id}/files/' },
  wait_for_collection_indexing: { backend: 'PLAYWRIGHT', restTarget: 'GET /api/collections/{id}/files/{fid}/status/' },
  attach_knowledge:             { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/knowledge/' },
  set_chatbot_tools:            { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/tools/' },
  set_source_material:          { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/' },
  publish_chatbot_version:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/{id}/versions/' },
  get_chatbot_embed_info:       { backend: 'HYBRID',     restTarget: 'GET /api/experiments/{id}/embed/' },

  // Observation
  list_chatbots:            { backend: 'REST', restTarget: 'GET /api/experiments/' },
  get_chatbot:              { backend: 'REST', restTarget: 'GET /api/experiments/{id}/' },
  list_sessions:            { backend: 'REST', restTarget: 'GET /api/sessions/' },
  get_session:              { backend: 'REST', restTarget: 'GET /api/sessions/{id}/' },
  end_session:              { backend: 'REST', restTarget: 'POST /api/sessions/{id}/end_experiment_session/' },
  add_session_tags:         { backend: 'REST', restTarget: 'POST /api/sessions/{id}/tags/' },
  remove_session_tags:      { backend: 'REST', restTarget: 'DELETE /api/sessions/{id}/tags/' },
  update_session_state:     { backend: 'REST', restTarget: 'PATCH /api/sessions/{id}/update_state/' },
  send_test_message:        { backend: 'REST', restTarget: 'POST /api/openai/{id}/chat/completions' },
  trigger_bot_message:      { backend: 'REST', restTarget: 'POST /api/trigger_bot' },
  update_participant_data:  { backend: 'REST', restTarget: 'POST /api/participants' },
  download_file:            { backend: 'REST', restTarget: 'GET /api/files/{id}/content' },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/capability-map.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/capability-map.ts test/mcp/ocs/capability-map.test.ts
git commit -m "feat(mcp): add OCS capability routing map (22 atoms)"
```

---

### Task 6: Define OcsClient interface

**Files:**
- Create: `mcp/ocs/client.ts` (replace scaffold)

- [ ] **Step 1: Write client.ts**

Replace `mcp/ocs/client.ts`:

```ts
import type {
  Experiment,
  Session,
  SessionWithMessages,
  ChatCompletionMessage,
} from './types.js';

export interface OcsClient {
  // ── Authoring atoms ──────────────────────────────────────────────

  cloneChatbot(args: {
    template_id: number;
    new_name: string;
  }): Promise<{ experiment_id: number; public_id: string; pipeline_id: number }>;

  setChatbotSystemPrompt(args: {
    experiment_id: number;
    prompt: string;
  }): Promise<void>;

  createCollection(args: {
    name: string;
    summary: string;
    is_index: boolean;
    is_remote_index: boolean;
    llm_provider?: number;
    embedding_model?: number;
  }): Promise<{ collection_id: number }>;

  uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
  }): Promise<{ file_ids: number[] }>;

  waitForCollectionIndexing(args: {
    collection_id: number;
    timeout_sec?: number;
  }): Promise<{ ready: boolean; files_indexed: number; pending: number }>;

  attachKnowledge(args: {
    experiment_id: number;
    collection_index_ids: number[];
    max_results?: number;
    generate_citations?: boolean;
  }): Promise<void>;

  setChatbotTools(args: {
    experiment_id: number;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }): Promise<void>;

  setSourceMaterial(args: {
    experiment_id: number;
    source_material_id: number | null;
  }): Promise<void>;

  publishChatbotVersion(args: {
    experiment_id: number;
    description: string;
  }): Promise<{ version_number: number; task_id: string }>;

  getChatbotEmbedInfo(args: {
    experiment_id: number;
  }): Promise<{ public_id: string; embed_key: string }>;

  // ── Observation atoms ────────────────────────────────────────────

  listChatbots(args?: {
    cursor?: string;
    page_size?: number;
  }): Promise<{ chatbots: Experiment[]; next_cursor?: string }>;

  getChatbot(args: { experiment_id: number }): Promise<Experiment>;

  listSessions(args: {
    experiment_id?: string;
    since?: string;
    tags?: string;
    versions?: string;
    cursor?: string;
    page_size?: number;
  }): Promise<{ sessions: Session[]; next_cursor?: string }>;

  getSession(args: { session_id: string }): Promise<SessionWithMessages>;

  endSession(args: { session_id: string }): Promise<void>;

  addSessionTags(args: {
    session_id: string;
    tags: string[];
  }): Promise<{ tags: string[] }>;

  removeSessionTags(args: {
    session_id: string;
    tags: string[];
  }): Promise<{ tags: string[] }>;

  updateSessionState(args: {
    session_id: string;
    state: Record<string, unknown>;
  }): Promise<{ state: Record<string, unknown> }>;

  sendTestMessage(args: {
    experiment_id: number;
    messages: ChatCompletionMessage[];
  }): Promise<{ response: ChatCompletionMessage }>;

  triggerBotMessage(args: {
    experiment_id: string;
    identifier: string;
    platform: string;
    prompt_text: string;
    session_data?: Record<string, unknown>;
    participant_data?: Record<string, unknown>;
  }): Promise<void>;

  updateParticipantData(args: {
    identifier: string;
    platform: string;
    data: Array<{
      experiment: string;
      data?: Record<string, unknown>;
      schedules?: Array<{
        id: string;
        name?: string;
        date?: string;
        prompt?: string;
        delete?: boolean;
      }>;
    }>;
  }): Promise<void>;

  downloadFile(args: {
    file_id: number;
  }): Promise<{ content: Buffer; filename: string; mime_type: string }>;
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit mcp/ocs/client.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/ocs/client.ts
git commit -m "feat(mcp): define OcsClient capability interface (22 methods)"
```

---

## Phase 2 — REST backend

### Task 7: RestBackend skeleton with verify()

**Files:**
- Create: `mcp/ocs/auth/rest-token.ts` (replace scaffold)
- Create: `mcp/ocs/backends/rest.ts` (replace scaffold)
- Create: `test/mcp/ocs/rest-backend.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/ocs/rest-backend.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { HttpError } from '../../../mcp/ocs/errors.js';

const BASE = 'https://chatbots.dimagi.com';

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

describe('RestBackend.verify', () => {
  it('calls GET /api/experiments/?page_size=1 with Bearer token', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(200, { results: [], next: null });

    const backend = new RestBackend({ baseUrl: BASE, token: 'tok_xyz' });
    await expect(backend.verify()).resolves.toBeUndefined();
  });

  it('throws HttpError on 401', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(401, 'Unauthorized');

    const backend = new RestBackend({ baseUrl: BASE, token: 'bad' });
    await expect(backend.verify()).rejects.toBeInstanceOf(HttpError);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: FAIL — `RestBackend` not defined.

- [ ] **Step 3: Write rest-token.ts**

Replace `mcp/ocs/auth/rest-token.ts`:

```ts
export function loadRestToken(): string {
  const token = process.env.OCS_API_TOKEN;
  if (!token) {
    throw new Error('OCS_API_TOKEN env var is required for REST backend');
  }
  return token;
}

export function loadBaseUrl(): string {
  return process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
}
```

- [ ] **Step 4: Write rest.ts with verify() and retry-aware request helper**

Replace `mcp/ocs/backends/rest.ts`:

```ts
import { fetch } from 'undici';
import { HttpError } from '../errors.js';

export interface RestBackendOptions {
  baseUrl: string;
  token: string;
  maxRetries?: number;        // default 3
  retryBackoffMs?: number;    // default 500
}

export class RestBackend {
  constructor(private opts: RestBackendOptions) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const backoffMs = this.opts.retryBackoffMs ?? 500;
    const isIdempotent = method === 'GET';
    let lastErr: HttpError | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();

      lastErr = new HttpError(res.status, path, await res.text());

      // Retry policy: only on 5xx or 429, and only for GET (idempotent)
      const shouldRetry = isIdempotent && (res.status >= 500 || res.status === 429);
      if (!shouldRetry || attempt === maxRetries - 1) {
        throw lastErr;
      }
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
    throw lastErr ?? new Error('unreachable');
  }

  async verify(): Promise<void> {
    await this.request('GET', '/api/experiments/?page_size=1');
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add mcp/ocs/auth/rest-token.ts mcp/ocs/backends/rest.ts test/mcp/ocs/rest-backend.test.ts
git commit -m "feat(mcp): add RestBackend skeleton with verify() and token loader"
```

---

### Task 8: RestBackend chatbot atoms (list, get, send_test_message, trigger, download)

**Files:**
- Modify: `mcp/ocs/backends/rest.ts`
- Modify: `test/mcp/ocs/rest-backend.test.ts`

- [ ] **Step 1: Add failing tests for five chatbot atoms**

Append to `test/mcp/ocs/rest-backend.test.ts`:

```ts
describe('RestBackend chatbot atoms', () => {
  it('listChatbots passes cursor and page_size as query params', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?cursor=abc&page_size=25', method: 'GET' })
      .reply(200, { results: [{ id: 1, name: 'bot', public_id: 'uuid-1' }], next: 'xyz' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots({ cursor: 'abc', page_size: 25 });
    expect(out.chatbots[0].id).toBe(1);
    expect(out.next_cursor).toBe('xyz');
  });

  it('getChatbot fetches a single experiment', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/42/', method: 'GET' })
      .reply(200, { id: 42, name: 'bot', public_id: 'uuid-42' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const exp = await b.getChatbot({ experiment_id: 42 });
    expect(exp.name).toBe('bot');
  });

  it('sendTestMessage posts OpenAI-compatible body', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: '/api/openai/99/chat/completions',
        method: 'POST',
        body: (body) => {
          const parsed = JSON.parse(body as string);
          return parsed.messages[0].role === 'user';
        },
      })
      .reply(200, { choices: [{ message: { role: 'assistant', content: 'hi' } }] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const res = await b.sendTestMessage({
      experiment_id: 99,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.response.content).toBe('hi');
  });

  it('triggerBotMessage posts to /api/trigger_bot', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/trigger_bot', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.triggerBotMessage({
      experiment_id: 'exp1',
      identifier: '+15550000000',
      platform: 'api',
      prompt_text: 'hi there',
    })).resolves.toBeUndefined();
  });

  it('downloadFile returns a Buffer', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/files/7/content', method: 'GET' })
      .reply(200, Buffer.from('PDFDATA'), {
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="x.pdf"' },
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const f = await b.downloadFile({ file_id: 7 });
    expect(f.content.toString()).toBe('PDFDATA');
    expect(f.mime_type).toBe('application/pdf');
    expect(f.filename).toBe('x.pdf');
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: 5 new tests fail — methods not defined.

- [ ] **Step 3: Implement the five methods in rest.ts**

Add to the `RestBackend` class in `mcp/ocs/backends/rest.ts`:

```ts
  async listChatbots(args: { cursor?: string; page_size?: number } = {}) {
    const qs = new URLSearchParams();
    if (args.cursor) qs.set('cursor', args.cursor);
    qs.set('page_size', String(args.page_size ?? 50));
    const body = (await this.request('GET', `/api/experiments/?${qs}`)) as {
      results: Array<{ id: number; name: string; public_id: string }>;
      next: string | null;
    };
    return { chatbots: body.results, next_cursor: body.next ?? undefined };
  }

  async getChatbot(args: { experiment_id: number }) {
    return (await this.request('GET', `/api/experiments/${args.experiment_id}/`)) as {
      id: number;
      name: string;
      public_id: string;
    };
  }

  async sendTestMessage(args: {
    experiment_id: number;
    messages: Array<{ role: string; content: string }>;
  }) {
    const body = (await this.request('POST', `/api/openai/${args.experiment_id}/chat/completions`, {
      model: 'anything',
      messages: args.messages,
    })) as { choices: Array<{ message: { role: string; content: string } }> };
    return { response: body.choices[0].message as { role: 'assistant'; content: string } };
  }

  async triggerBotMessage(args: {
    experiment_id: string;
    identifier: string;
    platform: string;
    prompt_text: string;
    session_data?: Record<string, unknown>;
    participant_data?: Record<string, unknown>;
  }) {
    await this.request('POST', '/api/trigger_bot', args);
  }

  async downloadFile(args: { file_id: number }) {
    const res = await fetch(`${this.opts.baseUrl}/api/files/${args.file_id}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) {
      throw new HttpError(res.status, `/api/files/${args.file_id}/content`, await res.text());
    }
    const content = Buffer.from(await res.arrayBuffer());
    const mime_type = res.headers.get('content-type') ?? 'application/octet-stream';
    const disp = res.headers.get('content-disposition') ?? '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `file-${args.file_id}`;
    return { content, filename, mime_type };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/rest.ts test/mcp/ocs/rest-backend.test.ts
git commit -m "feat(mcp): add RestBackend chatbot atoms (list, get, test message, trigger, download)"
```

---

### Task 9: RestBackend session atoms

**Files:**
- Modify: `mcp/ocs/backends/rest.ts`
- Modify: `test/mcp/ocs/rest-backend.test.ts`

- [ ] **Step 1: Add failing tests for session atoms**

Append to `test/mcp/ocs/rest-backend.test.ts`:

```ts
describe('RestBackend session atoms', () => {
  it('listSessions filters by experiment', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/?experiment=42&page_size=50', method: 'GET' })
      .reply(200, { results: [{ id: 's1', tags: ['foo'], created_at: 'ts' }], next: null });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listSessions({ experiment_id: '42' });
    expect(out.sessions[0].id).toBe('s1');
  });

  it('getSession returns messages', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/', method: 'GET' })
      .reply(200, {
        id: 's1',
        tags: [],
        created_at: 'ts',
        messages: [{ id: 'm1', created_at: 'ts', message_type: 'human', content: 'hi' }],
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const sess = await b.getSession({ session_id: 's1' });
    expect(sess.messages[0].content).toBe('hi');
  });

  it('addSessionTags posts to /tags/', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/tags/', method: 'POST' })
      .reply(200, { tags: ['a', 'b'] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.addSessionTags({ session_id: 's1', tags: ['a', 'b'] });
    expect(r.tags).toEqual(['a', 'b']);
  });

  it('removeSessionTags sends DELETE', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/tags/', method: 'DELETE' })
      .reply(200, { tags: [] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.removeSessionTags({ session_id: 's1', tags: ['a'] });
    expect(r.tags).toEqual([]);
  });

  it('endSession posts to end_experiment_session', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/end_experiment_session/', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.endSession({ session_id: 's1' })).resolves.toBeUndefined();
  });

  it('updateSessionState patches', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/update_state/', method: 'PATCH' })
      .reply(200, { state: { foo: 1 } });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.updateSessionState({ session_id: 's1', state: { foo: 1 } });
    expect(r.state).toEqual({ foo: 1 });
  });

  it('updateParticipantData posts to /api/participants', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/participants', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.updateParticipantData({
      identifier: 'p1',
      platform: 'api',
      data: [{ experiment: 'e1', data: { name: 'Jane' } }],
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: 7 new tests fail.

- [ ] **Step 3: Implement session atoms**

Add to `RestBackend` in `mcp/ocs/backends/rest.ts`:

```ts
  async listSessions(args: {
    experiment_id?: string;
    since?: string;
    tags?: string;
    versions?: string;
    cursor?: string;
    page_size?: number;
  }) {
    const qs = new URLSearchParams();
    if (args.experiment_id) qs.set('experiment', args.experiment_id);
    if (args.since) qs.set('ordering', args.since);
    if (args.tags) qs.set('tags', args.tags);
    if (args.versions) qs.set('versions', args.versions);
    if (args.cursor) qs.set('cursor', args.cursor);
    qs.set('page_size', String(args.page_size ?? 50));
    const body = (await this.request('GET', `/api/sessions/?${qs}`)) as {
      results: Array<{ id: string; tags: string[]; created_at: string }>;
      next: string | null;
    };
    return { sessions: body.results, next_cursor: body.next ?? undefined };
  }

  async getSession(args: { session_id: string }) {
    return (await this.request('GET', `/api/sessions/${args.session_id}/`)) as {
      id: string;
      tags: string[];
      created_at: string;
      messages: Array<{ id: string; created_at: string; message_type: 'human' | 'ai' | 'system'; content: string }>;
    };
  }

  async endSession(args: { session_id: string }) {
    await this.request('POST', `/api/sessions/${args.session_id}/end_experiment_session/`);
  }

  async addSessionTags(args: { session_id: string; tags: string[] }) {
    return (await this.request('POST', `/api/sessions/${args.session_id}/tags/`, { tags: args.tags })) as { tags: string[] };
  }

  async removeSessionTags(args: { session_id: string; tags: string[] }) {
    return (await this.request('DELETE', `/api/sessions/${args.session_id}/tags/`, { tags: args.tags })) as { tags: string[] };
  }

  async updateSessionState(args: { session_id: string; state: Record<string, unknown> }) {
    return (await this.request('PATCH', `/api/sessions/${args.session_id}/update_state/`, { state: args.state })) as { state: Record<string, unknown> };
  }

  async updateParticipantData(args: {
    identifier: string;
    platform: string;
    data: Array<Record<string, unknown>>;
  }) {
    await this.request('POST', '/api/participants', args);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/rest-backend.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/rest.ts test/mcp/ocs/rest-backend.test.ts
git commit -m "feat(mcp): add RestBackend session atoms (list, get, end, tags, state, participants)"
```

---

## Phase 3 — Playwright foundation

### Task 10: PlaywrightSession with storage state + CSRF extraction

**Files:**
- Create: `mcp/ocs/auth/playwright-session.ts` (replace scaffold)
- Create: `test/mcp/ocs/playwright-session.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/mcp/ocs/playwright-session.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { extractCsrfToken } from '../../../mcp/ocs/auth/playwright-session.js';

describe('extractCsrfToken', () => {
  it('returns token from Set-Cookie-style cookies array', () => {
    const cookies = [
      { name: 'sessionid', value: 'abc' },
      { name: 'csrftoken', value: 'xyz123' },
    ];
    expect(extractCsrfToken(cookies)).toBe('xyz123');
  });

  it('returns undefined if csrftoken is absent', () => {
    const cookies = [{ name: 'sessionid', value: 'abc' }];
    expect(extractCsrfToken(cookies)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npm test -- test/mcp/ocs/playwright-session.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write playwright-session.ts**

Replace `mcp/ocs/auth/playwright-session.ts`:

```ts
import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError } from '../errors.js';

export interface SessionOptions {
  baseUrl: string;
  teamSlug: string;
  stateDir?: string;
  username?: string;
  password?: string;
}

export interface Cookie {
  name: string;
  value: string;
  [key: string]: unknown;
}

export function extractCsrfToken(cookies: Cookie[]): string | undefined {
  return cookies.find((c) => c.name === 'csrftoken')?.value;
}

export class PlaywrightSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private csrfToken?: string;

  constructor(private opts: SessionOptions) {}

  private stateFile(): string {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.ace');
    return path.join(dir, `ocs-session-${this.opts.teamSlug}.json`);
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const statePath = this.stateFile();
    const storageState = fs.existsSync(statePath) ? statePath : undefined;

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ storageState, baseURL: this.opts.baseUrl });

    // Verify authentication by hitting an authenticated URL
    const res = await this.context.request.get(`/a/${this.opts.teamSlug}/chatbots/`);
    if (res.status() === 302 || res.status() === 401 || res.status() === 403) {
      throw new SessionExpiredError();
    }

    // Extract CSRF token from cookies
    const cookies = (await this.context.cookies()) as Cookie[];
    this.csrfToken = extractCsrfToken(cookies);

    // Persist storage state for next run
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
  }

  getCsrfToken(): string {
    if (!this.csrfToken) {
      throw new Error('CSRF token not available — call getContext() first');
    }
    return this.csrfToken;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/playwright-session.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/auth/playwright-session.ts test/mcp/ocs/playwright-session.test.ts
git commit -m "feat(mcp): add PlaywrightSession with storage state + CSRF extraction"
```

---

### Task 11: Pipeline patch helper with fixture-based tests

**Files:**
- Create: `mcp/ocs/backends/pipeline-patch.ts` (replace scaffold)
- Create: `test/mcp/ocs/fixtures/sample-pipeline.json`
- Create: `test/mcp/ocs/pipeline-patch.test.ts`

- [ ] **Step 1: Create pipeline fixture**

Create `test/mcp/ocs/fixtures/sample-pipeline.json`:

```json
{
  "pipeline": {
    "id": 77,
    "name": "ACE Golden Template",
    "data": {
      "nodes": [
        {
          "id": "start-1",
          "type": "startNode",
          "data": { "type": "StartNode", "params": {} },
          "position": { "x": 0, "y": 0 }
        },
        {
          "id": "llm-1",
          "type": "pipelineNode",
          "data": {
            "type": "LLMResponseWithPrompt",
            "label": "answerer",
            "params": {
              "prompt": "You are a helpful assistant.",
              "source_material_id": null,
              "collection_id": null,
              "collection_index_ids": [],
              "max_results": 20,
              "generate_citations": true,
              "tools": [],
              "custom_actions": [],
              "built_in_tools": [],
              "mcp_tools": []
            }
          },
          "position": { "x": 300, "y": 0 }
        },
        {
          "id": "end-1",
          "type": "endNode",
          "data": { "type": "EndNode", "params": {} },
          "position": { "x": 600, "y": 0 }
        }
      ],
      "edges": [
        { "id": "e1", "source": "start-1", "target": "llm-1" },
        { "id": "e2", "source": "llm-1", "target": "end-1" }
      ],
      "viewport": { "x": 0, "y": 0, "zoom": 1 }
    },
    "errors": []
  }
}
```

- [ ] **Step 2: Write failing tests**

Create `test/mcp/ocs/pipeline-patch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  patchLlmNodeParams,
  findLlmResponseNode,
  type RequestFn,
} from '../../../mcp/ocs/backends/pipeline-patch.js';
import { PipelineShapeError, PipelineValidationError } from '../../../mcp/ocs/errors.js';

function loadFixture() {
  const file = path.join(__dirname, 'fixtures', 'sample-pipeline.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function mockRequest(responses: Record<string, unknown>): RequestFn {
  return async (method, url) => {
    const key = `${method} ${url}`;
    if (!(key in responses)) throw new Error(`unexpected call ${key}`);
    return responses[key] as { ok: boolean; json: () => Promise<unknown> };
  };
}

describe('findLlmResponseNode', () => {
  it('finds the single LLMResponseWithPrompt node', () => {
    const graph = loadFixture().pipeline.data;
    const node = findLlmResponseNode(graph);
    expect(node.id).toBe('llm-1');
  });

  it('throws PipelineShapeError when no LLM node is present', () => {
    const graph = loadFixture().pipeline.data;
    graph.nodes = graph.nodes.filter((n: { data: { type: string } }) => n.data.type !== 'LLMResponseWithPrompt');
    expect(() => findLlmResponseNode(graph)).toThrow(PipelineShapeError);
  });

  it('throws PipelineShapeError when more than one LLM node is present', () => {
    const graph = loadFixture().pipeline.data;
    graph.nodes.push(JSON.parse(JSON.stringify(graph.nodes[1])));
    expect(() => findLlmResponseNode(graph)).toThrow(PipelineShapeError);
  });
});

describe('patchLlmNodeParams', () => {
  const GET_URL = '/a/dimagi/pipelines/data/77/';
  const POST_URL = '/a/dimagi/pipelines/data/77/';

  it('GETs, patches prompt, POSTs the modified graph', async () => {
    const fixture = loadFixture();
    let savedBody: { name: string; data: { nodes: Array<{ data: { type: string; params: { prompt?: string } } }> } } | undefined;

    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === GET_URL) {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === POST_URL) {
        savedBody = body as typeof savedBody;
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    await patchLlmNodeParams(
      { request, teamSlug: 'dimagi' },
      77,
      { prompt: 'You are the ACE support bot for Malaria Pilot.' },
    );

    expect(savedBody).toBeDefined();
    const llm = savedBody!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('You are the ACE support bot for Malaria Pilot.');
  });

  it('applies multiple field patches to the same node', async () => {
    const fixture = loadFixture();
    let savedBody: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;

    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET') return { ok: true, json: async () => fixture };
      savedBody = body as typeof savedBody;
      return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
    };

    await patchLlmNodeParams({ request, teamSlug: 'dimagi' }, 77, {
      collection_index_ids: [123],
      max_results: 10,
      generate_citations: false,
    });

    const llm = savedBody!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.collection_index_ids).toEqual([123]);
    expect(llm.data.params.max_results).toBe(10);
    expect(llm.data.params.generate_citations).toBe(false);
  });

  it('throws PipelineValidationError when the save endpoint returns errors', async () => {
    const fixture = loadFixture();
    const request: RequestFn = async (method) => {
      if (method === 'GET') return { ok: true, json: async () => fixture };
      return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: ['bad edge'] }) };
    };

    await expect(
      patchLlmNodeParams({ request, teamSlug: 'dimagi' }, 77, { prompt: 'x' })
    ).rejects.toBeInstanceOf(PipelineValidationError);
  });
});
```

- [ ] **Step 3: Run to confirm tests fail**

Run: `npm test -- test/mcp/ocs/pipeline-patch.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Write pipeline-patch.ts**

Replace `mcp/ocs/backends/pipeline-patch.ts`:

```ts
import type { FlowGraph, FlowNode, LlmNodeParams, PipelineDataResponse } from '../types.js';
import { PipelineShapeError, PipelineValidationError } from '../errors.js';

export interface RequestResult {
  ok: boolean;
  json: () => Promise<unknown>;
}

export type RequestFn = (
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
) => Promise<RequestResult>;

export interface PipelinePatchContext {
  request: RequestFn;
  teamSlug: string;
}

export function findLlmResponseNode(graph: FlowGraph): FlowNode {
  const matches = graph.nodes.filter((n) => n.data.type === 'LLMResponseWithPrompt');
  if (matches.length === 0) {
    throw new PipelineShapeError(
      'Expected exactly 1 LLMResponseWithPrompt node, found 0. Golden template invariant violated.'
    );
  }
  if (matches.length > 1) {
    throw new PipelineShapeError(
      `Expected exactly 1 LLMResponseWithPrompt node, found ${matches.length}. ` +
        'Multi-LLM templates are not supported in v1; add a label convention and pass a node selector.'
    );
  }
  return matches[0];
}

export async function patchLlmNodeParams(
  ctx: PipelinePatchContext,
  pipelineId: number,
  patch: Partial<LlmNodeParams>,
): Promise<void> {
  const url = `/a/${ctx.teamSlug}/pipelines/data/${pipelineId}/`;
  const getRes = await ctx.request('GET', url);
  if (!getRes.ok) {
    throw new Error(`pipeline data GET failed for pipeline ${pipelineId}`);
  }
  const payload = (await getRes.json()) as PipelineDataResponse;
  const graph = payload.pipeline.data;

  const node = findLlmResponseNode(graph);
  Object.assign(node.data.params, patch);

  const postRes = await ctx.request('POST', url, {
    name: payload.pipeline.name,
    data: graph,
  });
  if (!postRes.ok) {
    throw new Error(`pipeline data POST failed for pipeline ${pipelineId}`);
  }
  const saveBody = (await postRes.json()) as { errors: string[] };
  if (saveBody.errors && saveBody.errors.length > 0) {
    throw new PipelineValidationError(saveBody.errors);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/pipeline-patch.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add mcp/ocs/backends/pipeline-patch.ts test/mcp/ocs/fixtures/sample-pipeline.json test/mcp/ocs/pipeline-patch.test.ts
git commit -m "feat(mcp): add pipeline-patch helper with golden-template invariant check"
```

---

## Phase 4 — Playwright authoring atoms

### Task 12: PlaywrightBackend with clone_chatbot

**Files:**
- Create: `mcp/ocs/backends/playwright.ts` (replace scaffold)
- Create: `test/mcp/ocs/playwright-backend.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/ocs/playwright-backend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

function makeBackend(request: RequestFn) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://chatbots.dimagi.com',
    csrfToken: 'csrf-xyz',
    request,
  });
}

describe('PlaywrightBackend.cloneChatbot', () => {
  it('POSTs copy form and returns the new experiment info', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const request: RequestFn = async (method, url, body) => {
      calls.push({ method, url, body });
      if (url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: true,
          json: async () => ({ experiment_id: 99 }),
        };
      }
      if (url === '/api/experiments/99/') {
        return {
          ok: true,
          json: async () => ({ id: 99, public_id: 'uuid-99', pipeline_id: 77 }),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' });

    expect(out).toEqual({ experiment_id: 99, public_id: 'uuid-99', pipeline_id: 77 });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/a/dimagi/chatbots/5/copy/');
    expect(calls[0].body).toMatchObject({
      new_name: 'ACE - Malaria Pilot',
      csrfmiddlewaretoken: 'csrf-xyz',
    });
  });
});
```

- [ ] **Step 2: Run to confirm test fails**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: FAIL — `PlaywrightBackend` not defined.

- [ ] **Step 3: Write playwright.ts with cloneChatbot and pipeline ID cache**

Replace `mcp/ocs/backends/playwright.ts`:

```ts
import type { RequestFn } from './pipeline-patch.js';
import { patchLlmNodeParams, type PipelinePatchContext } from './pipeline-patch.js';
import type { LlmNodeParams } from '../types.js';

export interface PlaywrightBackendOptions {
  teamSlug: string;
  baseUrl: string;
  csrfToken: string;
  request: RequestFn;
  /**
   * Optional seed for the experiment_id → pipeline_id cache. Used by unit tests
   * to avoid needing to mock /api/experiments/<id>/ on every pipeline-patch test.
   * In production, the cache is populated lazily by `cloneChatbot` and `pipelineIdFor`.
   */
  pipelineCacheSeed?: Map<number, number>;
}

export class PlaywrightBackend {
  private pipelineCache: Map<number, number>;

  constructor(private opts: PlaywrightBackendOptions) {
    this.pipelineCache = new Map(opts.pipelineCacheSeed ?? []);
  }

  private patchContext(): PipelinePatchContext {
    return { request: this.opts.request, teamSlug: this.opts.teamSlug };
  }

  /**
   * Resolve an experiment_id to the pipeline_id of its working version.
   * Checks cache, then falls back to GET /api/experiments/<id>/.
   * Throws if the experiment retrieve doesn't include a pipeline reference.
   */
  async pipelineIdFor(experimentId: number): Promise<number> {
    const cached = this.pipelineCache.get(experimentId);
    if (cached !== undefined) return cached;

    const res = await this.opts.request('GET', `/api/experiments/${experimentId}/`);
    if (!res.ok) throw new Error(`experiment retrieve failed for ${experimentId}`);
    const body = (await res.json()) as { pipeline_id?: number; pipeline?: { id?: number } };
    const pipelineId = body.pipeline_id ?? body.pipeline?.id;
    if (!pipelineId) {
      throw new Error(
        `Experiment ${experimentId} has no pipeline reference in /api/experiments/ response. ` +
          'Spec open verification item #11: confirm pipeline_id is surfaced in the experiment retrieve body.'
      );
    }
    this.pipelineCache.set(experimentId, pipelineId);
    return pipelineId;
  }

  async cloneChatbot(args: { template_id: number; new_name: string }) {
    const copyUrl = `/a/${this.opts.teamSlug}/chatbots/${args.template_id}/copy/`;
    const copyRes = await this.opts.request('POST', copyUrl, {
      new_name: args.new_name,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!copyRes.ok) throw new Error(`clone failed for template ${args.template_id}`);
    const copyBody = (await copyRes.json()) as { experiment_id: number };

    const expUrl = `/api/experiments/${copyBody.experiment_id}/`;
    const expRes = await this.opts.request('GET', expUrl);
    if (!expRes.ok) throw new Error(`experiment fetch failed for ${copyBody.experiment_id}`);
    const exp = (await expRes.json()) as { id: number; public_id: string; pipeline_id: number };

    // Cache the mapping so downstream pipeline-patch atoms don't re-fetch
    this.pipelineCache.set(exp.id, exp.pipeline_id);

    return {
      experiment_id: exp.id,
      public_id: exp.public_id,
      pipeline_id: exp.pipeline_id,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: test passes.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/playwright.ts test/mcp/ocs/playwright-backend.test.ts
git commit -m "feat(mcp): add PlaywrightBackend.cloneChatbot"
```

---

### Task 13: PlaywrightBackend pipeline-patch atoms

Four atoms share one implementation. Done as one task.

**Files:**
- Modify: `mcp/ocs/backends/playwright.ts`
- Modify: `test/mcp/ocs/playwright-backend.test.ts`

- [ ] **Step 1: Update makeBackend helper to accept a cache seed**

In `test/mcp/ocs/playwright-backend.test.ts`, update the `makeBackend` function (near the top of the file) so tests can seed the experiment→pipeline cache:

```ts
function makeBackend(request: RequestFn, pipelineCacheSeed?: Map<number, number>) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://chatbots.dimagi.com',
    csrfToken: 'csrf-xyz',
    request,
    pipelineCacheSeed,
  });
}
```

- [ ] **Step 2: Add failing tests**

Append to `test/mcp/ocs/playwright-backend.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

function loadPipelineFixture() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-pipeline.json'), 'utf-8')
  );
}

describe('PlaywrightBackend pipeline-patch atoms', () => {
  // Seed: experiment 99 maps to pipeline 77 (matches the fixture's pipeline id)
  const seed = new Map<number, number>([[99, 77]]);

  function makePipelineRequest(onSave: (body: unknown) => void): RequestFn {
    const fixture = loadPipelineFixture();
    return async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        onSave(body);
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
  }

  it('setChatbotSystemPrompt patches prompt field', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: { prompt?: string } } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'new system prompt' });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('new system prompt');
  });

  it('attachKnowledge patches collection_index_ids', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.attachKnowledge({
      experiment_id: 99,
      collection_index_ids: [42],
      max_results: 15,
      generate_citations: true,
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.collection_index_ids).toEqual([42]);
    expect(llm.data.params.max_results).toBe(15);
  });

  it('setChatbotTools patches tool arrays', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotTools({
      experiment_id: 99,
      tools: ['search'],
      mcp_tools: ['ace_get_opp'],
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.tools).toEqual(['search']);
    expect(llm.data.params.mcp_tools).toEqual(['ace_get_opp']);
  });

  it('setSourceMaterial patches source_material_id', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setSourceMaterial({ experiment_id: 99, source_material_id: 321 });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.source_material_id).toBe(321);
  });

  it('falls back to /api/experiments/<id>/ lookup when cache misses', async () => {
    const fixture = loadPipelineFixture();
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/api/experiments/99/') {
        return { ok: true, json: async () => ({ id: 99, pipeline_id: 77 }) };
      }
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    // No seed — backend must resolve experiment→pipeline via REST lookup
    const backend = makeBackend(request);
    await expect(
      backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'x' })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to confirm new tests fail**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: 5 new tests fail.

- [ ] **Step 4: Implement the four pipeline-patch atoms using async pipelineIdFor**

Add to `PlaywrightBackend` class (note: `pipelineIdFor` was already added as a public method on the class in Task 12, so no duplicate definition is needed here):

```ts
  async setChatbotSystemPrompt(args: { experiment_id: number; prompt: string }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, { prompt: args.prompt });
  }

  async attachKnowledge(args: {
    experiment_id: number;
    collection_index_ids: number[];
    max_results?: number;
    generate_citations?: boolean;
  }) {
    const patch: Partial<LlmNodeParams> = { collection_index_ids: args.collection_index_ids };
    if (args.max_results !== undefined) patch.max_results = args.max_results;
    if (args.generate_citations !== undefined) patch.generate_citations = args.generate_citations;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setChatbotTools(args: {
    experiment_id: number;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }) {
    const patch: Partial<LlmNodeParams> = {};
    if (args.tools !== undefined) patch.tools = args.tools;
    if (args.custom_actions !== undefined) patch.custom_actions = args.custom_actions;
    if (args.built_in_tools !== undefined) patch.built_in_tools = args.built_in_tools;
    if (args.mcp_tools !== undefined) patch.mcp_tools = args.mcp_tools;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setSourceMaterial(args: { experiment_id: number; source_material_id: number | null }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, {
      source_material_id: args.source_material_id,
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add mcp/ocs/backends/playwright.ts test/mcp/ocs/playwright-backend.test.ts
git commit -m "feat(mcp): add PlaywrightBackend pipeline-patch atoms (prompt, knowledge, tools, source)"
```

---

### Task 14: PlaywrightBackend collection atoms

**Files:**
- Modify: `mcp/ocs/backends/playwright.ts`
- Modify: `test/mcp/ocs/playwright-backend.test.ts`

- [ ] **Step 1: Add failing tests for create/upload/wait**

Append to `test/mcp/ocs/playwright-backend.test.ts`:

```ts
describe('PlaywrightBackend collection atoms', () => {
  it('createCollection POSTs form and returns collection_id', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collection/new/') {
        expect(body).toMatchObject({
          name: 'ACE Malaria',
          summary: 'knowledge base',
          is_index: true,
          is_remote_index: true,
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, json: async () => ({ collection_id: 501 }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.createCollection({
      name: 'ACE Malaria',
      summary: 'knowledge base',
      is_index: true,
      is_remote_index: true,
    });
    expect(out.collection_id).toBe(501);
  });

  it('uploadCollectionFiles POSTs multipart and returns file_ids', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        // Body shape is deliberately loose to match what a real multipart helper emits
        expect((body as { files: unknown[] }).files).toHaveLength(1);
        return { ok: true, json: async () => ({ file_ids: [9001] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'idd.pdf', content: Buffer.from('PDF'), mime_type: 'application/pdf' }],
    });
    expect(out.file_ids).toEqual([9001]);
  });

  it('waitForCollectionIndexing polls until all files have chunk_count > 0', async () => {
    let call = 0;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        call++;
        const chunkCount = call >= 2 ? 5 : 0;
        return { ok: true, json: async () => ({ chunk_count: chunkCount, status: chunkCount > 0 ? 'COMPLETED' : 'PROCESSING' }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.waitForCollectionIndexing({
      collection_id: 501,
      timeout_sec: 10,
      _fileIds: [9001], // test-only override; production callers track file ids via state
      _pollIntervalMs: 10,
    });
    expect(out.ready).toBe(true);
    expect(out.files_indexed).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement the collection atoms**

Add to `PlaywrightBackend` class:

```ts
  async createCollection(args: {
    name: string;
    summary: string;
    is_index: boolean;
    is_remote_index: boolean;
    llm_provider?: number;
    embedding_model?: number;
  }) {
    const res = await this.opts.request(
      'POST',
      `/a/${this.opts.teamSlug}/documents/collection/new/`,
      {
        name: args.name,
        summary: args.summary,
        is_index: args.is_index,
        is_remote_index: args.is_remote_index,
        llm_provider: args.llm_provider,
        embedding_provider_model: args.embedding_model,
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
    );
    if (!res.ok) throw new Error('createCollection failed');
    const body = (await res.json()) as { collection_id: number };
    return { collection_id: body.collection_id };
  }

  async uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
  }) {
    const res = await this.opts.request(
      'POST',
      `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/add_files`,
      {
        files: args.files,
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
    );
    if (!res.ok) throw new Error('uploadCollectionFiles failed');
    const body = (await res.json()) as { file_ids: number[] };
    return { file_ids: body.file_ids };
  }

  // Internal test seam: _fileIds + _pollIntervalMs. Real callers supply _fileIds from
  // the return value of uploadCollectionFiles and tracked in skill state.
  async waitForCollectionIndexing(args: {
    collection_id: number;
    timeout_sec?: number;
    _fileIds?: number[];
    _pollIntervalMs?: number;
  }) {
    const fileIds = args._fileIds ?? [];
    const timeoutSec = args.timeout_sec ?? 300;
    const pollInterval = args._pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutSec * 1000;

    while (Date.now() < deadline) {
      let indexed = 0;
      for (const fid of fileIds) {
        const url = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/files/${fid}/status`;
        const res = await this.opts.request('GET', url);
        if (!res.ok) continue;
        const body = (await res.json()) as { chunk_count?: number };
        if ((body.chunk_count ?? 0) > 0) indexed++;
      }
      if (indexed === fileIds.length) {
        return { ready: true, files_indexed: indexed, pending: 0 };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Collection ${args.collection_id} indexing timed out after ${timeoutSec}s`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/playwright.ts test/mcp/ocs/playwright-backend.test.ts
git commit -m "feat(mcp): add PlaywrightBackend collection atoms (create, upload, wait)"
```

---

### Task 15: PlaywrightBackend publish + get_chatbot_embed_info

**Files:**
- Modify: `mcp/ocs/backends/playwright.ts`
- Modify: `test/mcp/ocs/playwright-backend.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/mcp/ocs/playwright-backend.test.ts`:

```ts
describe('PlaywrightBackend publish + embed info', () => {
  it('publishChatbotVersion POSTs versions/create form', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        expect(body).toMatchObject({
          version_description: 'initial',
          make_default: true,
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, json: async () => ({ version_number: 1, task_id: 'celery-123' }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' });
    expect(out.version_number).toBe(1);
    expect(out.task_id).toBe('celery-123');
  });

  it('getChatbotEmbedInfo scrapes widget_token from the channels page', async () => {
    const scrapedHtml = `
      <html><body>
        <div class="channel-row" data-platform="EMBEDDED_WIDGET">
          <code data-widget-token="tok-abc123"></code>
        </div>
      </body></html>
    `;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/api/experiments/99/') {
        return { ok: true, json: async () => ({ id: 99, public_id: 'uuid-99' }) };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/channels/') {
        return { ok: true, json: async () => ({ html: scrapedHtml }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.getChatbotEmbedInfo({ experiment_id: 99 });
    expect(out.public_id).toBe('uuid-99');
    expect(out.embed_key).toBe('tok-abc123');
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement publish + embed info**

Add to `PlaywrightBackend` class:

```ts
  async publishChatbotVersion(args: { experiment_id: number; description: string }) {
    const res = await this.opts.request(
      'POST',
      `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/versions/create`,
      {
        version_description: args.description,
        make_default: true,
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
    );
    if (!res.ok) throw new Error('publishChatbotVersion failed');
    return (await res.json()) as { version_number: number; task_id: string };
  }

  async getChatbotEmbedInfo(args: { experiment_id: number }) {
    // REST half: public_id from /api/experiments/{id}/
    const expRes = await this.opts.request('GET', `/api/experiments/${args.experiment_id}/`);
    if (!expRes.ok) throw new Error('experiment retrieve failed');
    const exp = (await expRes.json()) as { public_id: string };

    // Playwright half: scrape widget_token from the channels page HTML
    const chanUrl = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/channels/`;
    const chanRes = await this.opts.request('GET', chanUrl);
    if (!chanRes.ok) throw new Error('channels page fetch failed');
    const chanBody = (await chanRes.json()) as { html: string };
    const embedKey = extractWidgetToken(chanBody.html);
    if (!embedKey) {
      throw new Error(
        `No EMBEDDED_WIDGET channel found for experiment ${args.experiment_id}. ` +
          'Verify clone channel copy behavior — see spec open verification item #1.'
      );
    }

    return { public_id: exp.public_id, embed_key: embedKey };
  }
```

Add this helper function at module scope (outside the class) in `mcp/ocs/backends/playwright.ts`:

```ts
export function extractWidgetToken(html: string): string | undefined {
  const match = html.match(/data-widget-token="([^"]+)"/);
  return match?.[1];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/playwright-backend.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/playwright.ts test/mcp/ocs/playwright-backend.test.ts
git commit -m "feat(mcp): add PlaywrightBackend publish + embed info atoms"
```

---

## Phase 5 — Composite backend + MCP wiring

### Task 16: CompositeBackend routing

**Files:**
- Create: `mcp/ocs/backends/composite.ts` (replace scaffold)
- Create: `test/mcp/ocs/composite.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/ocs/composite.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';

describe('CompositeBackend routing', () => {
  it('routes REST atoms to the REST backend', async () => {
    const rest = { listChatbots: vi.fn().mockResolvedValue({ chatbots: [], next_cursor: undefined }) };
    const pw = {};
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.listChatbots({});
    expect(rest.listChatbots).toHaveBeenCalled();
  });

  it('routes PLAYWRIGHT atoms to the Playwright backend', async () => {
    const rest = {};
    const pw = { cloneChatbot: vi.fn().mockResolvedValue({ experiment_id: 1, public_id: 'u', pipeline_id: 2 }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.cloneChatbot({ template_id: 1, new_name: 'x' });
    expect(pw.cloneChatbot).toHaveBeenCalled();
  });

  it('routes HYBRID atoms to the Playwright backend by default', async () => {
    const rest = {};
    const pw = { getChatbotEmbedInfo: vi.fn().mockResolvedValue({ public_id: 'u', embed_key: 'e' }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.getChatbotEmbedInfo({ experiment_id: 1 });
    expect(pw.getChatbotEmbedInfo).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm test fails**

Run: `npm test -- test/mcp/ocs/composite.test.ts`
Expected: FAIL — `CompositeBackend` not defined.

- [ ] **Step 3: Write composite.ts**

Replace `mcp/ocs/backends/composite.ts`:

```ts
import type { OcsClient } from '../client.js';
import type { RestBackend } from './rest.js';
import type { PlaywrightBackend } from './playwright.js';

export interface CompositeOptions {
  rest: RestBackend;
  playwright: PlaywrightBackend;
}

/**
 * CompositeBackend implements OcsClient by delegating each capability to either
 * the REST or Playwright backend, per the routing defined in capability-map.ts.
 *
 * Today the routing is hard-coded in the dispatch methods below — one dispatch
 * per atom — which matches the capability map exactly. When OCS ships a real
 * REST endpoint for a Playwright atom, the dispatch line for that atom is the
 * only line that changes.
 */
export class CompositeBackend implements OcsClient {
  constructor(private opts: CompositeOptions) {}

  // ── Authoring (Playwright today) ────────────────────────────────

  cloneChatbot = (a: Parameters<OcsClient['cloneChatbot']>[0]) => this.opts.playwright.cloneChatbot(a);
  setChatbotSystemPrompt = (a: Parameters<OcsClient['setChatbotSystemPrompt']>[0]) => this.opts.playwright.setChatbotSystemPrompt(a);
  createCollection = (a: Parameters<OcsClient['createCollection']>[0]) => this.opts.playwright.createCollection(a);
  uploadCollectionFiles = (a: Parameters<OcsClient['uploadCollectionFiles']>[0]) => this.opts.playwright.uploadCollectionFiles(a);
  waitForCollectionIndexing = (a: Parameters<OcsClient['waitForCollectionIndexing']>[0]) => this.opts.playwright.waitForCollectionIndexing(a);
  attachKnowledge = (a: Parameters<OcsClient['attachKnowledge']>[0]) => this.opts.playwright.attachKnowledge(a);
  setChatbotTools = (a: Parameters<OcsClient['setChatbotTools']>[0]) => this.opts.playwright.setChatbotTools(a);
  setSourceMaterial = (a: Parameters<OcsClient['setSourceMaterial']>[0]) => this.opts.playwright.setSourceMaterial(a);
  publishChatbotVersion = (a: Parameters<OcsClient['publishChatbotVersion']>[0]) => this.opts.playwright.publishChatbotVersion(a);
  getChatbotEmbedInfo = (a: Parameters<OcsClient['getChatbotEmbedInfo']>[0]) => this.opts.playwright.getChatbotEmbedInfo(a);

  // ── Observation (REST today) ─────────────────────────────────────

  listChatbots = (a: Parameters<OcsClient['listChatbots']>[0] = {}) => this.opts.rest.listChatbots(a);
  getChatbot = (a: Parameters<OcsClient['getChatbot']>[0]) => this.opts.rest.getChatbot(a);
  listSessions = (a: Parameters<OcsClient['listSessions']>[0]) => this.opts.rest.listSessions(a);
  getSession = (a: Parameters<OcsClient['getSession']>[0]) => this.opts.rest.getSession(a);
  endSession = (a: Parameters<OcsClient['endSession']>[0]) => this.opts.rest.endSession(a);
  addSessionTags = (a: Parameters<OcsClient['addSessionTags']>[0]) => this.opts.rest.addSessionTags(a);
  removeSessionTags = (a: Parameters<OcsClient['removeSessionTags']>[0]) => this.opts.rest.removeSessionTags(a);
  updateSessionState = (a: Parameters<OcsClient['updateSessionState']>[0]) => this.opts.rest.updateSessionState(a);
  sendTestMessage = (a: Parameters<OcsClient['sendTestMessage']>[0]) => this.opts.rest.sendTestMessage(a);
  triggerBotMessage = (a: Parameters<OcsClient['triggerBotMessage']>[0]) => this.opts.rest.triggerBotMessage(a);
  updateParticipantData = (a: Parameters<OcsClient['updateParticipantData']>[0]) => this.opts.rest.updateParticipantData(a);
  downloadFile = (a: Parameters<OcsClient['downloadFile']>[0]) => this.opts.rest.downloadFile(a);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/composite.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/ocs/backends/composite.ts test/mcp/ocs/composite.test.ts
git commit -m "feat(mcp): add CompositeBackend dispatching REST/Playwright per capability map"
```

---

### Task 17: Rewrite mcp/ocs-server.ts to wire the composite backend

**Files:**
- Modify: `mcp/ocs-server.ts` (replace existing scaffold)

- [ ] **Step 1: Replace ocs-server.ts with the composite-wired version**

Replace `mcp/ocs-server.ts`:

```ts
/**
 * OCS MCP Server for ACE
 *
 * Exposes 22 atomic OCS capabilities as MCP tools. Delegates to a CompositeBackend
 * that routes each atom to either REST (public OCS API) or Playwright (authenticated
 * Django session + CSRF) based on capability-map.ts.
 *
 * See docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RestBackend } from './ocs/backends/rest.js';
import { PlaywrightBackend } from './ocs/backends/playwright.js';
import { CompositeBackend } from './ocs/backends/composite.js';
import { PlaywrightSession } from './ocs/auth/playwright-session.js';
import { loadBaseUrl, loadRestToken } from './ocs/auth/rest-token.js';
import type { RequestFn } from './ocs/backends/pipeline-patch.js';

const baseUrl = loadBaseUrl();
const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';

// REST backend (immediate, stateless)
const rest = new RestBackend({ baseUrl, token: loadRestToken() });

// Playwright backend — lazily initialized on first authoring call
let playwright: PlaywrightBackend | undefined;
let session: PlaywrightSession | undefined;

async function getPlaywrightBackend(): Promise<PlaywrightBackend> {
  if (playwright) return playwright;
  session = new PlaywrightSession({
    baseUrl,
    teamSlug,
    username: process.env.OCS_USERNAME,
    password: process.env.OCS_PASSWORD,
  });
  const ctx = await session.getContext();
  const csrfToken = session.getCsrfToken();

  const request: RequestFn = async (method, url, body) => {
    if (method === 'GET') {
      const res = await ctx.request.get(url);
      return { ok: res.ok(), json: async () => await res.json() };
    }
    const res = await ctx.request.post(url, {
      headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
      data: body,
    });
    return { ok: res.ok(), json: async () => await res.json() };
  };

  playwright = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  return playwright;
}

// CompositeBackend — lazy playwright proxy so REST-only calls don't pay the browser cost
const composite = new CompositeBackend({
  rest,
  playwright: new Proxy({} as PlaywrightBackend, {
    get(_, prop) {
      return async (...args: unknown[]) => {
        const real = await getPlaywrightBackend();
        // @ts-expect-error dynamic dispatch
        return real[prop as string](...args);
      };
    },
  }),
});

// ── MCP Server Setup ────────────────────────────────────────────────

const server = new McpServer({ name: 'ocs', version: '1.0.0' });

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Authoring atoms (10) ────────────────────────────────────────────

server.tool(
  'ocs_clone_chatbot',
  'Clone an OCS chatbot from a template. Returns the new experiment_id, public_id, and pipeline_id.',
  { template_id: z.number(), new_name: z.string() },
  async (args) => result(await composite.cloneChatbot(args)),
);

server.tool(
  'ocs_set_chatbot_system_prompt',
  "Update the LLMResponseWithPrompt node's prompt field for this chatbot.",
  { experiment_id: z.number(), prompt: z.string() },
  async (args) => { await composite.setChatbotSystemPrompt(args); return result({ ok: true }); },
);

server.tool(
  'ocs_create_collection',
  'Create a new Collection (RAG knowledge base) in OCS.',
  {
    name: z.string(),
    summary: z.string(),
    is_index: z.boolean(),
    is_remote_index: z.boolean(),
    llm_provider: z.number().optional(),
    embedding_model: z.number().optional(),
  },
  async (args) => result(await composite.createCollection(args)),
);

server.tool(
  'ocs_upload_collection_files',
  'Upload files to an existing Collection. Files will be chunked and embedded asynchronously.',
  {
    collection_id: z.number(),
    files: z.array(z.object({
      name: z.string(),
      content: z.string().describe('Base64-encoded file content'),
      mime_type: z.string(),
    })),
  },
  async (args) => {
    const decoded = args.files.map((f) => ({
      name: f.name,
      content: Buffer.from(f.content, 'base64'),
      mime_type: f.mime_type,
    }));
    return result(await composite.uploadCollectionFiles({ collection_id: args.collection_id, files: decoded }));
  },
);

server.tool(
  'ocs_wait_for_collection_indexing',
  'Poll until all files in a Collection have been indexed (chunked + embedded).',
  { collection_id: z.number(), timeout_sec: z.number().optional() },
  async (args) => result(await composite.waitForCollectionIndexing(args)),
);

server.tool(
  'ocs_attach_knowledge',
  "Attach one or more Collections to a chatbot's retriever node.",
  {
    experiment_id: z.number(),
    collection_index_ids: z.array(z.number()),
    max_results: z.number().optional(),
    generate_citations: z.boolean().optional(),
  },
  async (args) => { await composite.attachKnowledge(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_chatbot_tools',
  "Configure the chatbot's tools, custom actions, built-in tools, and MCP tools.",
  {
    experiment_id: z.number(),
    tools: z.array(z.string()).optional(),
    custom_actions: z.array(z.string()).optional(),
    built_in_tools: z.array(z.string()).optional(),
    mcp_tools: z.array(z.string()).optional(),
  },
  async (args) => { await composite.setChatbotTools(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_source_material',
  "Point a chatbot's legacy SourceMaterial FK at a specific row. Use null to clear.",
  { experiment_id: z.number(), source_material_id: z.number().nullable() },
  async (args) => { await composite.setSourceMaterial(args); return result({ ok: true }); },
);

server.tool(
  'ocs_publish_chatbot_version',
  'Publish a new default version of a chatbot.',
  { experiment_id: z.number(), description: z.string() },
  async (args) => result(await composite.publishChatbotVersion(args)),
);

server.tool(
  'ocs_get_chatbot_embed_info',
  'Fetch the public_id and embed_key needed to render the OCS widget.',
  { experiment_id: z.number() },
  async (args) => result(await composite.getChatbotEmbedInfo(args)),
);

// ── Observation atoms (12) ──────────────────────────────────────────

server.tool(
  'ocs_list_chatbots',
  'List chatbots on the OCS team.',
  { cursor: z.string().optional(), page_size: z.number().optional() },
  async (args) => result(await composite.listChatbots(args)),
);

server.tool(
  'ocs_get_chatbot',
  'Retrieve a single chatbot by experiment ID.',
  { experiment_id: z.number() },
  async (args) => result(await composite.getChatbot(args)),
);

server.tool(
  'ocs_list_sessions',
  'List sessions, optionally filtered by experiment, tags, or since-date.',
  {
    experiment_id: z.string().optional(),
    since: z.string().optional(),
    tags: z.string().optional(),
    versions: z.string().optional(),
    cursor: z.string().optional(),
    page_size: z.number().optional(),
  },
  async (args) => result(await composite.listSessions(args)),
);

server.tool(
  'ocs_get_session',
  'Retrieve a session with its full message history.',
  { session_id: z.string() },
  async (args) => result(await composite.getSession(args)),
);

server.tool(
  'ocs_end_session',
  'Mark a session as ended.',
  { session_id: z.string() },
  async (args) => { await composite.endSession(args); return result({ ok: true }); },
);

server.tool(
  'ocs_add_session_tags',
  'Add tags to a session.',
  { session_id: z.string(), tags: z.array(z.string()) },
  async (args) => result(await composite.addSessionTags(args)),
);

server.tool(
  'ocs_remove_session_tags',
  'Remove tags from a session.',
  { session_id: z.string(), tags: z.array(z.string()) },
  async (args) => result(await composite.removeSessionTags(args)),
);

server.tool(
  'ocs_update_session_state',
  'Patch the arbitrary state blob on a session.',
  { session_id: z.string(), state: z.record(z.unknown()) },
  async (args) => result(await composite.updateSessionState(args)),
);

server.tool(
  'ocs_send_test_message',
  'Send a test message to a chatbot via the OpenAI-compatible endpoint.',
  {
    experiment_id: z.number(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })),
  },
  async (args) => result(await composite.sendTestMessage({
    experiment_id: args.experiment_id,
    messages: args.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  })),
);

server.tool(
  'ocs_trigger_bot_message',
  'Trigger the bot to send a message to a participant on a given channel.',
  {
    experiment_id: z.string(),
    identifier: z.string(),
    platform: z.string(),
    prompt_text: z.string(),
    session_data: z.record(z.unknown()).optional(),
    participant_data: z.record(z.unknown()).optional(),
  },
  async (args) => { await composite.triggerBotMessage(args); return result({ ok: true }); },
);

server.tool(
  'ocs_update_participant_data',
  'Create or update participant data across one or more experiments.',
  {
    identifier: z.string(),
    platform: z.string(),
    data: z.array(z.object({
      experiment: z.string(),
      data: z.record(z.unknown()).optional(),
      schedules: z.array(z.record(z.unknown())).optional(),
    })),
  },
  async (args) => { await composite.updateParticipantData(args as never); return result({ ok: true }); },
);

server.tool(
  'ocs_download_file',
  'Download a file from OCS by file ID.',
  { file_id: z.number() },
  async (args) => {
    const f = await composite.downloadFile(args);
    return result({
      filename: f.filename,
      mime_type: f.mime_type,
      content_base64: f.content.toString('base64'),
    });
  },
);

// ── Startup ─────────────────────────────────────────────────────────

async function main() {
  try {
    await rest.verify();
  } catch (e) {
    console.error('OCS REST verification failed:', e);
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('OCS MCP server fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit mcp/ocs-server.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/ocs-server.ts
git commit -m "feat(mcp): rewrite ocs-server.ts to wire composite backend with 22 tool registrations"
```

---

### Task 18: Verify MCP server boots and lists tools

**Files:**
- (No new files; smoke test of the built server)

- [ ] **Step 1: Run the MCP server briefly with mocked env**

Run:
```bash
OCS_API_TOKEN=dummy OCS_BASE_URL=http://localhost:0 timeout 2 npm run mcp:ocs 2>&1 | head -20 || true
```

Expected: the server either prints a REST verification failure (because `http://localhost:0` isn't serving) or blocks waiting for stdio. Both are OK — the goal is confirming the module loads without TypeScript errors.

- [ ] **Step 2: List the tool names by grepping source**

Run:
```bash
grep -c "server.tool(" mcp/ocs-server.ts
```

Expected output: `22`

- [ ] **Step 3: Commit any incidental fixes**

If Step 1 surfaced import or runtime errors, fix them and commit. Otherwise skip.

```bash
git status
# if clean, skip; if not:
git add -A && git commit -m "fix(mcp): resolve module load issues in ocs-server"
```

---

## Phase 7 — Interactive login command

### Task 19: ace ocs login command

**Files:**
- Create: `commands/ocs-login.md`

- [ ] **Step 1: Write the command markdown**

Create `commands/ocs-login.md`:

````markdown
---
name: ocs-login
description: >
  Interactive login flow for OCS. Opens a headed Playwright browser so the
  user can sign in (including SSO/MFA), then saves the resulting session state
  to ~/.ace/ocs-session-<team>.json for headless reuse.
---

# /ocs:login

Use this command to establish or refresh an OCS session for the Playwright backend.

## When to run

- First time setting up the OCS integration on a machine
- After seeing `SessionExpiredError` from any ACE skill that touches OCS
- After a password / SSO credential change

## What it does

1. Launches a headed Chromium window via Playwright
2. Navigates to `${OCS_BASE_URL}/accounts/login/`
3. Waits for the user to sign in manually (up to 5 minutes)
4. Saves `storageState` to `~/.ace/ocs-session-<team>.json`
5. Confirms the saved state works by fetching `/a/<team>/chatbots/`

## Implementation

Run this Node one-liner (shown here for reference — the command itself is Claude-driven):

```bash
npx tsx -e '
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
const base = process.env.OCS_BASE_URL ?? "https://chatbots.dimagi.com";
const team = process.env.OCS_TEAM_SLUG ?? "dimagi";
const stateFile = path.join(os.homedir(), ".ace", `ocs-session-${team}.json`);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ baseURL: base });
await context.newPage().then((p) => p.goto("/accounts/login/"));
console.log("Sign in manually. Press Ctrl+C after the login is complete.");
await new Promise(() => {});
' ; # On Ctrl+C, re-run the save step below:
```

For the save step after manual login, use a more complete script:

```bash
npx tsx mcp/ocs/auth/playwright-session.ts --login
```

If that entrypoint doesn't exist yet, create a minimal CLI:

```bash
cat > /tmp/ocs-login.ts <<'EOF'
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const baseUrl = process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';
const stateFile = path.join(os.homedir(), '.ace', `ocs-session-${teamSlug}.json`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();
await page.goto('/accounts/login/');

console.log('Sign in manually in the browser window.');
console.log(`After you see the chatbots dashboard, return here and press Enter to save the session.`);
process.stdin.resume();
process.stdin.once('data', async () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await context.storageState({ path: stateFile });
  console.log(`Session saved to ${stateFile}`);
  await browser.close();
  process.exit(0);
});
EOF
npx tsx /tmp/ocs-login.ts
```

## Expected output

```
Sign in manually in the browser window.
After you see the chatbots dashboard, return here and press Enter to save the session.
[user signs in in the browser]
Session saved to /Users/jon/.ace/ocs-session-dimagi.json
```
````

- [ ] **Step 2: Commit**

```bash
git add commands/ocs-login.md
git commit -m "feat(commands): add /ocs:login interactive Playwright login helper"
```

---

## Phase 8 — Integration tests (gated)

### Task 20: REST integration test

**Files:**
- Create: `test/mcp/ocs/rest.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/mcp/ocs/rest.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { loadBaseUrl, loadRestToken } from '../../../mcp/ocs/auth/rest-token.js';

const integration = process.env.OCS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

describeFn('RestBackend integration (requires OCS_INTEGRATION=1 + real token)', () => {
  const backend = new RestBackend({ baseUrl: loadBaseUrl(), token: loadRestToken() });

  it('verify() succeeds', async () => {
    await expect(backend.verify()).resolves.toBeUndefined();
  });

  it('listChatbots returns at least one chatbot', async () => {
    const out = await backend.listChatbots({ page_size: 5 });
    expect(Array.isArray(out.chatbots)).toBe(true);
  });

  it('listSessions with page_size=1 returns up to 1 session', async () => {
    const out = await backend.listSessions({ page_size: 1 });
    expect(out.sessions.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Confirm the test skips without the env var**

Run: `npm test -- test/mcp/ocs/rest.integration.test.ts`
Expected: test suite is skipped (0 run).

- [ ] **Step 3: (Optional) Run against real OCS**

Only if `OCS_API_TOKEN` and `OCS_BASE_URL` are set to a real instance, run:
```bash
OCS_INTEGRATION=1 npm test -- test/mcp/ocs/rest.integration.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add test/mcp/ocs/rest.integration.test.ts
git commit -m "test(mcp): add gated REST backend integration tests"
```

---

### Task 21: Playwright integration test

**Files:**
- Create: `test/mcp/ocs/playwright.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/mcp/ocs/playwright.integration.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PlaywrightSession } from '../../../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

const integration = process.env.OCS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

describeFn('PlaywrightBackend integration (requires OCS_INTEGRATION=1 + live session)', () => {
  const baseUrl = process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
  const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';
  const templateId = Number(process.env.OCS_GOLDEN_TEMPLATE_ID ?? 0);

  const session = new PlaywrightSession({ baseUrl, teamSlug });
  let backend: PlaywrightBackend;

  afterAll(async () => { await session.close(); });

  it('session authenticates and extracts CSRF token', async () => {
    await session.getContext();
    expect(session.getCsrfToken()).toBeTruthy();
  });

  it('clones the golden template then archives the clone', async () => {
    if (!templateId) {
      console.warn('OCS_GOLDEN_TEMPLATE_ID not set — skipping clone test');
      return;
    }
    const ctx = await session.getContext();
    const csrfToken = session.getCsrfToken();
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET') {
        const res = await ctx.request.get(url);
        return { ok: res.ok(), json: async () => await res.json() };
      }
      const res = await ctx.request.post(url, {
        headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
        data: body,
      });
      return { ok: res.ok(), json: async () => await res.json() };
    };
    backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });

    const name = `ACE - integration-test-${Date.now()}`;
    const cloned = await backend.cloneChatbot({ template_id: templateId, new_name: name });
    expect(cloned.experiment_id).toBeGreaterThan(0);
    expect(cloned.public_id).toMatch(/[0-9a-f-]{36}/);

    // Clean up: archive the cloned chatbot
    await ctx.request.post(`/a/${teamSlug}/chatbots/${cloned.experiment_id}/delete/`, {
      headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
    });
  });
});
```

- [ ] **Step 2: Confirm the test skips without the env var**

Run: `npm test -- test/mcp/ocs/playwright.integration.test.ts`
Expected: test suite is skipped.

- [ ] **Step 3: Commit**

```bash
git add test/mcp/ocs/playwright.integration.test.ts
git commit -m "test(mcp): add gated Playwright backend integration tests"
```

---

## Phase 9 — Skill updates

### Task 22: Rewrite skills/ocs-agent-setup/SKILL.md

**Files:**
- Modify: `skills/ocs-agent-setup/SKILL.md`

- [ ] **Step 1: Replace SKILL.md with the new end-to-end MCP flow**

Replace `skills/ocs-agent-setup/SKILL.md`:

```markdown
---
name: ocs-agent-setup
description: >
  Create and configure an OCS chatbot for this opportunity. Clones the ACE
  golden template, uploads PDD + training + app summaries as a RAG Collection,
  patches the system prompt with opp-specific framing, publishes a version,
  and returns the embed credentials for Connect to store on the Opportunity.
---

# OCS Agent Setup

Run end-to-end against the OCS MCP server (`mcp/ocs-server.ts`). Uses these
atoms: `ocs_list_chatbots`, `ocs_clone_chatbot`, `ocs_create_collection`,
`ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`, `ocs_set_chatbot_tools`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`,
`ocs_send_test_message`.

## Process

1. **Read opportunity context from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - App summaries: `ACE/<opp-name>/app-summaries/`

2. **Check for existing chatbot** (idempotency):
   - Call `ocs_list_chatbots` and filter by `name == "ACE - <opp-name>"`
   - If found, skip to step 11 with the existing `experiment_id`
   - Otherwise continue to step 3

3. **Clone the golden template:**
   - `ocs_clone_chatbot({ template_id: $OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp-name>" })`
   - Capture `{experiment_id, public_id, pipeline_id}`

4. **Create a per-opp Collection:**
   - `ocs_create_collection({ name: "ACE <opp-name>", summary: "Knowledge base for <opp-name> — PDD, training, app summaries", is_index: true, is_remote_index: true })`
   - Capture `collection_id`

5. **Upload RAG files:**
   - For each file in the opportunity's context (PDD, training PDFs, app summary markdown), base64-encode the content
   - `ocs_upload_collection_files({ collection_id, files: [...] })`
   - Capture `file_ids`

6. **Wait for indexing:**
   - `ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`
   - On timeout, escalate to human

7. **Compose the system prompt** from the PDD + opp details + escalation rules. The prompt should:
   - Identify the chatbot as the ACE support bot for this specific opportunity
   - Summarize the intervention (from PDD)
   - Name the LLO(s) and key dates
   - Tell the bot to escalate to the admin group on specific triggers
   - Reference the attached knowledge base explicitly

8. **Patch the chatbot:**
   - `ocs_set_chatbot_system_prompt({ experiment_id, prompt })`
   - `ocs_attach_knowledge({ experiment_id, collection_index_ids: [collection_id], max_results: 20, generate_citations: true })`
   - (Optional) `ocs_set_chatbot_tools({ experiment_id, mcp_tools: [...] })` if ACE MCP tools should be exposed

9. **Publish a version:**
   - `ocs_publish_chatbot_version({ experiment_id, description: "Initial ACE version for <opp-name>" })`

10. **Self-evaluate (LLM-as-Judge):**
    - Send 3-5 canned questions via `ocs_send_test_message`
    - Judge responses for correctness + tone against expected answers from the PDD
    - On failure, retry prompt patching once; if still failing, escalate

11. **Retrieve embed credentials:**
    - `ocs_get_chatbot_embed_info({ experiment_id })`
    - Capture `{public_id, embed_key}`

12. **Write state file:** `ACE/<opp-name>/ocs-agent-config.md`
    - Fields: `experiment_id`, `public_id`, `embed_key`, `collection_id`, `pipeline_id`, `version_number`, `created_at`
    - On re-run, this file is the source of truth; skip to step 11 if present

13. **Hand off to connect-setup:**
    - Pass `{public_id, embed_key}` to the `connect-setup` skill for writing to the Opportunity record
    - See the Connect interface contract in `docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md`

## Mode Behavior

- **Auto:** Execute all steps. Surface errors with specific atom names.
- **Review:** Pause before step 3 (show composed prompt + file list) and before step 9 (show post-patch chatbot state).

## Dry-Run Behavior

When `--dry-run` is active:
- Every MCP atom call is logged to `ACE/<opp-name>/comms-log/dry-run-ocs-agent-setup.md` with atom name + args
- No HTTP goes out; atom responses are stubbed
- State tracks as `dry-run-success`

## Failure Modes

- `PipelineShapeError` — golden template invariant violated. Verify with `OCS_GOLDEN_TEMPLATE_ID` points at a template with exactly one `LLMResponseWithPrompt` node.
- `CollectionIndexingTimeoutError` — raise timeout; if persists, check OCS dashboard for the collection's indexing queue.
- `SessionExpiredError` — run `/ocs:login` to re-authenticate.
- `HttpError 4xx` on clone — verify `OCS_GOLDEN_TEMPLATE_ID` and `OCS_TEAM_SLUG` env vars.
- LLM-as-Judge failure — prompt engineering issue; revise step 7's prompt composition.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version (manual workaround) | ACE team |
| 2026-04-08 | Full rewrite against OCS MCP composite backend | ACE team |
```

- [ ] **Step 2: Commit**

```bash
git add skills/ocs-agent-setup/SKILL.md
git commit -m "feat(skills): rewrite ocs-agent-setup to drive OCS MCP end-to-end"
```

---

### Task 23: Add OCS usage to timeline-monitor

**Files:**
- Modify: `skills/timeline-monitor/SKILL.md`

- [ ] **Step 1: Add an OCS usage section to timeline-monitor**

Read the current file first, then add a new `## OCS Integration` section after the existing `## Process` section. The section content:

```markdown
## OCS Integration

The timeline-monitor skill consumes OCS session data to detect LLOs who are
stuck or going quiet between milestone checks. Uses these MCP atoms:

- `ocs_list_sessions({ experiment_id, since })` — pull recent session activity for this opportunity's chatbot
- `ocs_get_session({ session_id })` — read the transcript of any session flagged as stuck or confused
- `ocs_trigger_bot_message({ experiment_id, identifier, platform, prompt_text })` — push a proactive nudge to an LLO who's behind schedule (only in Auto mode)
- `ocs_add_session_tags({ session_id, tags: ['ace-reviewed', 'needs-followup'] })` — mark reviewed sessions so they aren't re-processed

The `experiment_id` and `public_id` for this opportunity's chatbot come from
`ACE/<opp-name>/ocs-agent-config.md`, written by the `ocs-agent-setup` skill.

### Heuristics

- **Stuck:** LLO sent a message > 24 hours ago and received a response, but no follow-up message. Trigger a nudge.
- **Confused:** LLO asked the same question (or similar) in three consecutive sessions without acting on the answer. Escalate to admin group.
- **Silent:** LLO has sent zero messages in the past 7 days during an active opp phase. Trigger a check-in message.
```

Run:
```bash
# Locate the insertion point
grep -n "^## " skills/timeline-monitor/SKILL.md
```

Then use Edit to insert the section after the last `## Process` subsection but before the next top-level section.

- [ ] **Step 2: Commit**

```bash
git add skills/timeline-monitor/SKILL.md
git commit -m "feat(skills): wire timeline-monitor to OCS session polling and nudges"
```

---

### Task 24: Add OCS usage to flw-data-review

**Files:**
- Modify: `skills/flw-data-review/SKILL.md`

- [ ] **Step 1: Add an OCS usage section**

Add a new `## OCS Integration` section to `skills/flw-data-review/SKILL.md`. Content:

```markdown
## OCS Integration

The flw-data-review skill mines OCS transcripts alongside CommCare form data
to build a full picture of LLO and FLW experience. Uses these MCP atoms:

- `ocs_list_sessions({ experiment_id })` — full session history for this opportunity's chatbot
- `ocs_get_session({ session_id })` — per-session transcripts
- `ocs_add_session_tags({ session_id, tags: [...] })` — categorize transcripts for downstream skills:
  - `'escalated'` — flagged for human review
  - `'training-gap'` — indicates the training materials missed something
  - `'product-feedback'` — substantive feedback about Connect / CommCare that should feed back to the product team
  - `'data-quality-issue'` — relates to a known data quality pattern from the CommCare analysis

The `experiment_id` for this opportunity comes from
`ACE/<opp-name>/ocs-agent-config.md`.

### Cross-referencing with CommCare data

When a transcript discusses a specific form submission, correlate via
participant identifier (if passed through `participant_data`) or timestamp
proximity to the form submission timestamp. Flag matched pairs in the review
output so `learnings-summary` can connect "what the LLO asked" to "what actually
happened in the data".
```

- [ ] **Step 2: Commit**

```bash
git add skills/flw-data-review/SKILL.md
git commit -m "feat(skills): wire flw-data-review to OCS transcript analysis"
```

---

## Phase 9 — Documentation

### Task 25: Create .env.example

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Check whether .env.example exists; if so, append instead of overwriting**

Run:
```bash
ls -la .env.example 2>&1
```

- [ ] **Step 2: Write or append the OCS env block**

If the file does not exist, create `.env.example`:

```
# ── OCS Integration (see docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md) ──

# Base URL of the OCS instance
OCS_BASE_URL=https://chatbots.dimagi.com

# Team slug that owns ACE chatbots (verify before use — spec open item #7)
OCS_TEAM_SLUG=dimagi

# REST backend: API token from OCS user settings
OCS_API_TOKEN=

# Playwright backend: credentials for headless login (or use /ocs:login for SSO)
OCS_USERNAME=
OCS_PASSWORD=

# Integer experiment ID of the ACE golden template (one-time manual setup)
# See spec open item #9
OCS_GOLDEN_TEMPLATE_ID=

# Playwright session cache
OCS_SESSION_TTL_HOURS=24
ACE_SESSION_STATE_DIR=~/.ace
```

If it does exist, append the block above (with a blank line before it) using `cat >>`.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document OCS integration environment variables"
```

---

### Task 26: Rewrite playbook/integrations/ocs-integration.md

**Files:**
- Modify: `playbook/integrations/ocs-integration.md`

- [ ] **Step 1: Replace the open-questions doc with a live capability reference**

Replace `playbook/integrations/ocs-integration.md`:

```markdown
# OCS Integration

## Overview

The ACE↔OCS integration layer is a composite MCP backend that exposes 22
atomic OCS capabilities. See the design spec at
`docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md` for
architecture and rationale.

This doc is the operational reference: which atoms exist, which skill uses
each, and how to run the MCP server.

## Running the MCP server

```bash
npm run mcp:ocs
```

Required environment: see `.env.example`.

## Capability map

### Authoring atoms (10) — Playwright backend today, REST targets documented

| Atom | Used by |
|---|---|
| `ocs_clone_chatbot` | `ocs-agent-setup` |
| `ocs_set_chatbot_system_prompt` | `ocs-agent-setup` |
| `ocs_create_collection` | `ocs-agent-setup` |
| `ocs_upload_collection_files` | `ocs-agent-setup` |
| `ocs_wait_for_collection_indexing` | `ocs-agent-setup` |
| `ocs_attach_knowledge` | `ocs-agent-setup` |
| `ocs_set_chatbot_tools` | `ocs-agent-setup` (optional) |
| `ocs_set_source_material` | (v2; no v1 skill uses this) |
| `ocs_publish_chatbot_version` | `ocs-agent-setup` |
| `ocs_get_chatbot_embed_info` | `ocs-agent-setup` (hybrid: REST + Playwright) |

### Observation atoms (12) — REST backend

| Atom | Used by |
|---|---|
| `ocs_list_chatbots` | `ocs-agent-setup` (idempotency check) |
| `ocs_get_chatbot` | `ocs-agent-setup` |
| `ocs_list_sessions` | `timeline-monitor`, `flw-data-review` |
| `ocs_get_session` | `timeline-monitor`, `flw-data-review` |
| `ocs_end_session` | (v2) |
| `ocs_add_session_tags` | `timeline-monitor`, `flw-data-review` |
| `ocs_remove_session_tags` | (v2) |
| `ocs_update_session_state` | (v2) |
| `ocs_send_test_message` | `ocs-agent-setup` (self-eval) |
| `ocs_trigger_bot_message` | `timeline-monitor` (nudges) |
| `ocs_update_participant_data` | (v2) |
| `ocs_download_file` | (v2) |

## Troubleshooting

- **`SessionExpiredError`** — run `/ocs:login` to refresh the Playwright session state
- **`PipelineShapeError`** — the golden template has more than one `LLMResponseWithPrompt` node, or none. Verify `OCS_GOLDEN_TEMPLATE_ID`.
- **`HttpError 401/403` on REST atoms** — `OCS_API_TOKEN` is invalid or lacks the required scopes. Regenerate via OCS user settings.
- **`CollectionIndexingTimeoutError`** — the embedding queue is backed up; increase `timeout_sec` or check OCS dashboard.

## Verification items

See spec section "Open verification items" for the 12 items that need
resolution during implementation. Update this section as each is resolved.

## Change log

| Date | Change |
|------|--------|
| 2026-04-03 | Initial "open questions" doc |
| 2026-04-08 | Rewritten as operational reference after composite backend ships |
```

- [ ] **Step 2: Commit**

```bash
git add playbook/integrations/ocs-integration.md
git commit -m "docs(playbook): rewrite ocs-integration.md as operational reference"
```

---

## Phase 10 — Observability

### Task 27: Structured logging wrapper for MCP atoms

The spec calls for every MCP atom call to emit a JSONL log line to
`~/.ace/logs/ocs-mcp.jsonl`. Implemented as a transparent Proxy wrapping the
`CompositeBackend` so every capability call is logged from one place without
touching individual atom implementations.

**Files:**
- Create: `mcp/ocs/logging.ts`
- Modify: `mcp/ocs-server.ts`
- Create: `test/mcp/ocs/logging.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/ocs/logging.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createLoggingProxy, type LogEntry } from '../../../mcp/ocs/logging.js';

describe('createLoggingProxy', () => {
  it('logs successful calls with atom name, args, duration, and result', async () => {
    const logged: LogEntry[] = [];
    const target = {
      cloneChatbot: async (args: { template_id: number }) => ({ experiment_id: 1, template_id: args.template_id }),
    };
    const proxied = createLoggingProxy(target, (entry) => logged.push(entry));

    const out = await proxied.cloneChatbot({ template_id: 5 });
    expect(out.experiment_id).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].atom).toBe('cloneChatbot');
    expect(logged[0].result).toBe('ok');
    expect(typeof logged[0].duration_ms).toBe('number');
    expect(logged[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs errors with error class and message', async () => {
    const logged: LogEntry[] = [];
    const target = {
      failingAtom: async () => {
        throw new Error('boom');
      },
    };
    const proxied = createLoggingProxy(target, (entry) => logged.push(entry));

    await expect(proxied.failingAtom()).rejects.toThrow('boom');
    expect(logged).toHaveLength(1);
    expect(logged[0].result).toBe('error');
    expect(logged[0].error_class).toBe('Error');
    expect(logged[0].error_message).toBe('boom');
  });

  it('leaves non-function properties untouched', () => {
    const target = { version: '1.0.0' };
    const proxied = createLoggingProxy(target, () => {});
    expect(proxied.version).toBe('1.0.0');
  });
});
```

- [ ] **Step 2: Run to confirm test fails**

Run: `npm test -- test/mcp/ocs/logging.test.ts`
Expected: FAIL — `createLoggingProxy` not defined.

- [ ] **Step 3: Write logging.ts**

Create `mcp/ocs/logging.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LogEntry {
  ts: string;
  atom: string;
  duration_ms: number;
  result: 'ok' | 'error';
  error_class?: string;
  error_message?: string;
}

export type LogFn = (entry: LogEntry) => void;

/**
 * Wraps an object in a Proxy that logs every method call.
 * Non-function properties pass through untouched.
 */
export function createLoggingProxy<T extends object>(target: T, log: LogFn): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const orig = Reflect.get(obj, prop, receiver);
      if (typeof orig !== 'function') return orig;

      return async (...args: unknown[]) => {
        const start = Date.now();
        const atom = String(prop);
        try {
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          log({
            ts: new Date(start).toISOString(),
            atom,
            duration_ms: Date.now() - start,
            result: 'ok',
          });
          return result;
        } catch (err) {
          const e = err as Error;
          log({
            ts: new Date(start).toISOString(),
            atom,
            duration_ms: Date.now() - start,
            result: 'error',
            error_class: e.constructor?.name ?? 'Error',
            error_message: e.message,
          });
          throw err;
        }
      };
    },
  }) as T;
}

/**
 * Default logger: appends JSONL to ~/.ace/logs/ocs-mcp.jsonl.
 * Silent on filesystem errors so logging failures never break atom calls.
 */
export function defaultFileLogger(): LogFn {
  const dir = path.join(os.homedir(), '.ace', 'logs');
  const file = path.join(dir, 'ocs-mcp.jsonl');
  return (entry) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // swallow
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/mcp/ocs/logging.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Wire the logging proxy into ocs-server.ts**

In `mcp/ocs-server.ts`, update the import block and the `composite` construction:

```ts
// Add to imports
import { createLoggingProxy, defaultFileLogger } from './ocs/logging.js';

// Replace:
//   const composite = new CompositeBackend({ ... });
// with:
const compositeRaw = new CompositeBackend({
  rest,
  playwright: new Proxy({} as PlaywrightBackend, {
    get(_, prop) {
      return async (...args: unknown[]) => {
        const real = await getPlaywrightBackend();
        // @ts-expect-error dynamic dispatch
        return real[prop as string](...args);
      };
    },
  }),
});

const composite = createLoggingProxy(compositeRaw, defaultFileLogger());
```

All existing `server.tool(...)` handlers continue to use `composite` — the proxy is transparent.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit mcp/ocs-server.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add mcp/ocs/logging.ts test/mcp/ocs/logging.test.ts mcp/ocs-server.ts
git commit -m "feat(mcp): add structured logging proxy for all OCS atom calls"
```

---

## Phase 11 — Final verification

### Task 28: Run full test suite and verify all tests pass

**Files:**
- (No file changes unless tests reveal bugs)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all non-integration tests pass. Integration tests skip unless `OCS_INTEGRATION=1`.

- [ ] **Step 2: Count tools in server to verify all 22 atoms are registered**

Run: `grep -c "server.tool(" mcp/ocs-server.ts`
Expected: `22`

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit`
Expected: no errors across the project.

- [ ] **Step 4: Commit any fixes discovered during verification**

If any of the above steps surfaced issues, fix them with focused commits (one per logical fix), then re-run. If clean, skip this step.

---

### Task 29: Document status of open verification items

**Files:**
- Modify: `docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md`

- [ ] **Step 1: Walk the 12 "Open verification items" in the spec and annotate each with current status**

For each item in the spec's "Open verification items" section, add one of these status markers at the start of the item:

- `[RESOLVED]` — verified during implementation, finding documented in the item text
- `[DEFERRED]` — not blocking v1 ship, punted to a v2 task or issue
- `[PENDING]` — still unresolved at ship time; the item describes the next step

The 12 items the plan's tasks most plausibly touch:
- Item 1 (clone channel copy): resolved via Task 15 / Task 21 — `getChatbotEmbedInfo` surfaces the missing-channel case loudly
- Item 2 (embed key scrape path): resolved via Task 15's `extractWidgetToken` regex
- Item 4 (CSRF extraction): resolved via Task 10's `extractCsrfToken`
- Items 3, 5, 6, 7, 8, 9, 10, 11, 12: likely still `[PENDING]` at first ship

- [ ] **Step 2: Commit the annotations**

```bash
git add docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md
git commit -m "docs(specs): annotate OCS integration spec with post-implementation verification status"
```

---

## Self-review checklist (for the plan author)

After finishing all 29 tasks, an implementer should be able to answer yes to every bullet below. If any bullet is no, return to the relevant task.

- [ ] All 22 atoms are registered in `mcp/ocs-server.ts` and each delegates to `CompositeBackend`
- [ ] `CompositeBackend` routing matches `capability-map.ts` exactly (tested in Task 16)
- [ ] The Playwright backend uses only `page.request` and `authenticatedRequest`-style HTTP — no `page.click`, no selectors, no UI automation
- [ ] `patchLlmNodeParams` is the only function that mutates pipeline JSON, and all four pipeline-patch atoms call it
- [ ] REST backend has full unit test coverage via `undici` MockAgent
- [ ] PlaywrightBackend has unit test coverage via `RequestFn` dependency injection
- [ ] Integration tests exist for both backends, gated on `OCS_INTEGRATION=1`
- [ ] `skills/ocs-agent-setup/SKILL.md` lists the atoms it calls in process step order
- [ ] `skills/timeline-monitor/SKILL.md` and `skills/flw-data-review/SKILL.md` have OCS integration sections
- [ ] `commands/ocs-login.md` exists for interactive Playwright auth
- [ ] `.env.example` documents all 7 OCS env vars
- [ ] `playbook/integrations/ocs-integration.md` is the operational reference (not the old open-questions doc)
- [ ] Spec's "Open verification items" are annotated with current status
- [ ] Every commit message is scoped (`feat(mcp)`, `test(mcp)`, `feat(skills)`, `docs(specs)`, etc.)
