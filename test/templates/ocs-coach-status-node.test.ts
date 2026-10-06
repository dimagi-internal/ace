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
pd, ss, tmp = {}, {}, {}
env = dict(
    get_participant_data=lambda: dict(pd),
    set_participant_data=lambda d: (pd.clear(), pd.update(d)),
    get_temp_state_key=lambda k: tmp.get(k),
    get_session_state_key=lambda k: ss.get(k),
    set_session_state_key=lambda k, v: ss.__setitem__(k, v),
)
exec(src, env)
replies = []
for t in turns:
    tmp["user_input"] = t.get("user", "")
    replies.append(env["main"](t["bot"]))
print(json.dumps({"replies": replies, "pd": pd}))
`;

function run(turns: Array<{ bot: string; user?: string }>) {
  const r = spawnSync('python3', ['-I', '-c', HARNESS, NODE, JSON.stringify(turns)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { replies: string[]; pd: Record<string, unknown> };
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
});
