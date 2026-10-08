/**
 * The ACE Coach's OCS Python node (templates/ocs-coach/status_node.py), run for
 * real under python3 with OCS's helper functions stubbed. The node is the only
 * thing between the model's output and the worker's phone, so what it strips and
 * what it records are both worker-facing.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE = fileURLToPath(new URL('../../templates/ocs-coach/status_node.py', import.meta.url));

const HARNESS = `
import json, sys
src = open(sys.argv[1]).read()
turns = json.loads(sys.argv[2])
opts = json.loads(sys.argv[3])
pd, ss, tmp = {}, dict(opts.get("session_state", {})), {}
fetches, attachments = [], []

class Http:
    # OCS RestrictedHttpClient's shape: get() returns a dict, raises on transport errors.
    def get(self, url, *, params=None, headers=None, auth=None, timeout=None):
        fetches.append({"url": url, "auth": auth})
        r = opts.get("http")
        if r is None:
            raise RuntimeError("Connection error: refused")
        return {"status_code": r["status"], "headers": {"content-type": r.get("type", "")},
                "content": r.get("body", "").encode()}

env = dict(
    get_participant_data=lambda: dict(pd),
    set_participant_data=lambda d: (pd.clear(), pd.update(d)),
    get_temp_state_key=lambda k: tmp.get(k),
    get_session_state_key=lambda k: ss.get(k),
    set_session_state_key=lambda k, v: ss.__setitem__(k, v),
    http=Http(),
    add_file_attachment=lambda name, content, content_type=None: attachments.append(
        {"name": name, "bytes": len(content), "type": content_type, "turn": len(replies)}),
)
exec(src, env)
replies = []
for t in turns:
    tmp["user_input"] = t.get("user", "")
    replies.append(env["main"](t["bot"]))
print(json.dumps({"replies": replies, "pd": pd, "ss": ss, "fetches": fetches, "attachments": attachments}))
`;

type HttpStub = { status: number; type?: string; body?: string } | null;
type RunOpts = { session_state?: Record<string, unknown>; http?: HttpStub };

function run(turns: Array<{ bot: string; user?: string }>, opts: RunOpts = {}) {
  const r = spawnSync('python3', ['-I', '-c', HARNESS, NODE, JSON.stringify(turns), JSON.stringify(opts)], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as {
    replies: string[];
    pd: Record<string, unknown>;
    ss: Record<string, unknown>;
    fetches: Array<{ url: string; auth: string }>;
    attachments: Array<{ name: string; bytes: number; type: string; turn: number }>;
  };
}

describe('ACE Coach status node', () => {
  it('strips markers, including backtick-wrapped ones, without leaving stray code spans (ace#2744)', () => {
    const { replies, pd } = run([
      { bot: 'Hello! Is now a good time?' },
      {
        user: 'yes',
        bot: 'Thank you.\n\n`[[COACH_TOPIC:SF_P1|agreement=agree|cause=environment|owner=worker|plan=meet weekly|by=4 weeks|note=rains]]`\n\nTake care.\n`[[COACH_DONE]]`',
      },
    ]);
    expect(replies[1]).toBe('Thank you.\n\nTake care.');
    expect(replies[1]).not.toMatch(/`|\[\[/);
    expect(pd.chatbot_task_status).toBe('completed');
    expect(pd.chatbot_topics_done).toEqual(['SF_P1']);
  });

  it('records a disputed topic as needing review, and never duplicates a topic key', () => {
    const marker = '[[COACH_TOPIC:SF_D1|agreement=disputed|cause=measurement|owner=program|plan=none|by=none|note=same people every week]]';
    const { pd } = run([
      { bot: 'Hello!' },
      { user: 'no, that is right', bot: `Thanks.\n${marker}` },
      { user: 'ok', bot: `Noted.\n${marker}` },
    ]);
    expect(pd.chatbot_topics_done).toEqual(['SF_D1']);
    expect(pd.chatbot_review_needed).toBe(true);
    expect(pd.chatbot_task_status).toBe('in_progress');
  });

  describe('optional briefing picture (coach_image_url)', () => {
    const URL_ = 'https://labs.example/coach-image/signed-token/';
    const PNG: HttpStub = { status: 200, type: 'image/png', body: 'PNGDATA' };
    const turns = [
      { user: 'yes, I have a few minutes', bot: 'Good. The programme noticed something.' },
      { user: 'ok', bot: 'What happened?' },
      { user: 'network', bot: 'Thanks.' },
    ];

    it('attaches it to the first reply only, authenticated as the connect-labs provider', () => {
      const out = run(turns, { session_state: { coach_image_url: URL_ }, http: PNG });
      expect(out.fetches).toEqual([{ url: URL_, auth: 'connect-labs' }]);
      expect(out.attachments).toEqual([{ name: 'your-progress.png', bytes: 7, type: 'image/png', turn: 0 }]);
      expect(out.ss.coach_image_sent).toBe(true);
      expect(out.ss.coach_image_error).toBeUndefined();
      expect(out.replies[0]).toBe('Good. The programme noticed something.');
    });

    it('does nothing at all without a coach_image_url — the picture is optional', () => {
      const out = run(turns, { http: PNG });
      expect(out.fetches).toEqual([]);
      expect(out.attachments).toEqual([]);
      expect(out.ss.coach_image_sent).toBeUndefined();
    });

    it('a failed fetch still sends the reply, records why, and is never retried', () => {
      for (const http of [null, { status: 403, type: 'application/json', body: '{}' }, { status: 200, type: 'text/html', body: '<html>' }]) {
        const out = run(turns, { session_state: { coach_image_url: URL_ }, http });
        expect(out.attachments).toEqual([]);
        expect(out.fetches).toHaveLength(1);
        expect(String(out.ss.coach_image_error)).not.toBe('');
        expect(out.ss.coach_image_error).toBeDefined();
        expect(out.replies).toEqual(['Good. The programme noticed something.', 'What happened?', 'Thanks.']);
      }
    });
  });
});
