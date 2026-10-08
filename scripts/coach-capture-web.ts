/**
 * Web mode of skills/coach-session-capture: hold one ACE Coach conversation in OCS's
 * own chat page, playing the worker from a scripted persona, and record it.
 *
 *   npx tsx scripts/coach-capture-web.ts --preview <preview.json> --experiment-pk 14002 \
 *     --version 3 --persona agree --out <dir> [--team connect-ace] [--ocs-login <email>]
 *
 * `--preview` is Labs' own `start_ocs_outreach` preview (workflow_run_action without
 * `confirm`); the start is built from it by lib/coach-session-capture.ts `webStart` —
 * the same `message_text` and `session_data` mobile mode sends through Labs.
 *
 * Why this path (each step checked live 2026-10-07, chlorine Coach 14002):
 *   - OCS `trigger_bot` cannot start a browser-reachable session: `web` and `api`
 *     answer "Chatbot cannot send messages on the <platform> channel. Create the
 *     channel first." (those channels are team-level; trigger_bot looks one up per
 *     chatbot), and `embedded_widget` answers HTTP 500 (OCS `ApiChannel` raises
 *     "requires either an existing session or a user", which trigger_bot never
 *     passes).
 *   - A session started by the Chat API (`POST /api/chat/start/`) takes
 *     `session_data` as its state, but OCS's chat page needs the session's integer
 *     id, which no API returns.
 *   - So this starts the session the way a person does in OCS — "start a web chat"
 *     (`start_authed_web_session`, which redirects to the chat page) — and writes
 *     the start's `session_data` into the session state before the first message
 *     (`PATCH /api/sessions/<id>/update_state/`; trigger_bot merges session_data
 *     into state the same way). The Coach reads `{session_state.coach_briefing}`
 *     on every turn, so the briefing is in place from the first reply.
 *
 * The ONE difference from mobile, which no OCS surface lets us remove: the Coach's
 * fixed opening (`message_text`) is not in this session's history — OCS has no way
 * to put a verbatim bot message into a browser chat. The page records the opening
 * as the first line of transcript.json (`opening_not_in_history: true`) and the
 * worker's first turn answers it, exactly as on the phone.
 *
 * Writes <out>/video.webm, <out>/transcript.json, <out>/shots/NN.png.
 */
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { findOverstatements } from '../lib/coach-briefing.js';
import {
  PERSONA_TURNS,
  topicsFromBriefing,
  webStart,
  type CoachStart,
  type OutreachPreview,
  type Persona,
} from '../lib/coach-session-capture.js';

loadPluginEnv(import.meta.url);

const { values } = parseArgs({
  options: {
    preview: { type: 'string' },
    'ocs-login': { type: 'string' },
    'experiment-pk': { type: 'string' },
    version: { type: 'string' },
    persona: { type: 'string', default: 'agree' },
    out: { type: 'string' },
    team: { type: 'string' },
    'reply-timeout-s': { type: 'string', default: '120' },
  },
});
if (!values.preview || !values['experiment-pk'] || !values.version || !values.out) {
  throw new Error('--preview, --experiment-pk, --version and --out are required');
}
const persona = values.persona as Persona;
const turns = PERSONA_TURNS[persona];
if (!turns) throw new Error(`unknown --persona ${persona}; one of ${Object.keys(PERSONA_TURNS).join(', ')}`);
const ocsLogin = values['ocs-login'] ?? process.env.OCS_USERNAME;
if (!ocsLogin) throw new Error('no --ocs-login and OCS_USERNAME is unset');
const start: CoachStart = webStart(JSON.parse(fs.readFileSync(values.preview, 'utf8')) as OutreachPreview, ocsLogin);
const baseUrl = (process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com').replace(/\/$/, '');
const team = values.team ?? process.env.OCS_TEAM_SLUG;
const apiToken = process.env.OCS_API_TOKEN;
if (!team) throw new Error('no --team and OCS_TEAM_SLUG is unset');
if (!apiToken) throw new Error('OCS_API_TOKEN is unset (plugin .env)');
const replyTimeoutMs = Number(values['reply-timeout-s']) * 1000;
const out = path.resolve(values.out);
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });

interface ApiMessage {
  role: string;
  content: string;
}

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: path.join(os.homedir(), '.ace', `ocs-session-${team}.json`),
    baseURL: baseUrl,
    viewport: { width: 430, height: 860 },
    recordVideo: { dir: out, size: { width: 430, height: 860 } },
  });
  const page = await context.newPage();
  try {
    await page.goto(`/a/${team}/chatbots/${values['experiment-pk']}/`);
    if (page.url().includes('/accounts/login')) throw new Error(`OCS session for ${team} is not logged in — run /ace:ocs-login`);
    const csrf = (await context.cookies()).find((c) => c.name === 'csrftoken')?.value;
    if (!csrf) throw new Error('no csrftoken cookie in the OCS session');

    const started = await page.request.post(
      `/a/${team}/chatbots/${values['experiment-pk']}/v/${values.version}/start_authed_web_session/`,
      { headers: { 'X-CSRFToken': csrf, Referer: page.url() }, maxRedirects: 0 },
    );
    const chatPath = started.headers()['location'];
    if (started.status() !== 302 || !chatPath) {
      throw new Error(`start_authed_web_session -> HTTP ${started.status()} (the web channel may be disabled)`);
    }
    await page.goto(chatPath);
    const form = await page.locator('form[hx-post*="/session/"]').first().getAttribute('hx-post');
    const sessionId = form?.match(/\/session\/([0-9a-f-]{36})\/message\//)?.[1];
    if (!sessionId) throw new Error(`could not read the session id from ${chatPath}`);

    // The production start's session_data, before the first worker message.
    const state = await api('PATCH', `/api/sessions/${sessionId}/update_state/`, { state: start.session_data });
    if (state.state?.coach_briefing !== start.session_data.coach_briefing) {
      throw new Error('session state did not take the briefing');
    }
    await page.reload();
    await page.screenshot({ path: path.join(out, 'shots', '00-start.png') });

    const transcript: Array<{ role: string; content: string; at: string }> = [
      { role: 'ai (opening, sent by Labs on mobile; not in this session’s history)', content: start.message_text, at: new Date().toISOString() },
    ];
    let aiSeen = 0;
    for (const [i, turn] of turns.entries()) {
      await page.getByRole('textbox', { name: 'Message' }).fill(turn);
      await page.getByRole('button', { name: 'Send' }).click();
      transcript.push({ role: 'worker', content: turn, at: new Date().toISOString() });
      const deadline = Date.now() + replyTimeoutMs;
      let reply: ApiMessage | undefined;
      while (Date.now() < deadline) {
        const s = await api('GET', `/api/sessions/${sessionId}/`);
        const ai = (s.messages as ApiMessage[]).filter((m) => m.role === 'assistant' || m.role === 'ai');
        if (ai.length > aiSeen) {
          reply = ai[ai.length - 1];
          aiSeen = ai.length;
          break;
        }
        await page.waitForTimeout(2000);
      }
      if (!reply) throw new Error(`no Coach reply within ${replyTimeoutMs / 1000}s after turn ${i + 1}`);
      transcript.push({ role: 'coach', content: reply.content, at: new Date().toISOString() });
      // Let the page's own poll render the reply before the next turn and the screenshot.
      await page.getByText(reply.content.slice(0, 40), { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(out, 'shots', `${String(i + 1).padStart(2, '0')}-turn.png`) });
    }

    const final = await api('GET', `/api/sessions/${sessionId}/`);
    const overstatements = findOverstatements(
      transcript.filter((t) => t.role === 'coach').map((t) => t.content),
      topicsFromBriefing(start.session_data.coach_briefing),
    );
    fs.writeFileSync(
      path.join(out, 'transcript.json'),
      JSON.stringify(
        {
          mode: 'web',
          persona,
          session_id: sessionId,
          chat_url: `${baseUrl}${chatPath}`,
          opening_not_in_history: true,
          start,
          transcript,
          state: final.state,
          participant_data: final.participant_data,
          overstatements,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        session_id: sessionId,
        chat_url: `${baseUrl}${chatPath}`,
        turns: turns.length,
        task_status: final.participant_data?.chatbot_task_status,
        overstatements: overstatements.length,
      }),
    );
  } finally {
    const video = page.video();
    await context.close();
    if (video) fs.renameSync(await video.path(), path.join(out, 'video.webm'));
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
