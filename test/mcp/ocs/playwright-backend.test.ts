import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PlaywrightBackend,
  extractWidgetToken,
  extractPublicId,
  extractPipelineId,
  extractEmbeddedWidgetChannelId,
  extractExperimentIdFromLocation,
  parseChatbotTable,
  assertCollectionPromptInvariant,
  classifyChannelEnabled,
} from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';
import {
  VersionBadgeUnreadableError,
  WidgetChannelDisabledError,
  WidgetChannelStateUnreadableError,
} from '../../../mcp/ocs/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeBackend(request: RequestFn, pipelineCacheSeed?: Map<number, number>) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://www.openchatstudio.com',
    csrfToken: 'csrf-xyz',
    request,
    pipelineCacheSeed,
  });
}

function loadPipelineFixture() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-pipeline.json'), 'utf-8')
  );
}

// Realistic HTML fragments pulled from the actual OCS templates.
// These anchor the scrape regexes to the real DOM shape so a template change
// upstream will surface as a test failure.

// Anchored on the REAL DOM from templates/chatbots/single_chatbot_home.html
// — specifically the hidden api-url-link input which is always rendered
// regardless of the flag_chat_widget feature flag state.
//
// The `<open-chat-studio-widget>` tag below simulates the global OCS support
// widget that renders on every authenticated page. Its chatbot-id is a
// synthetic test UUID — its only job is to ensure extractPublicId does NOT
// match it (which would be a regression, since the support widget isn't the
// current experiment).
const HOME_HTML_WITH_WIDGET = `
<html><body>
  <h1 id="chatbot-name">ACE - Malaria Pilot</h1>
  <!-- Channels section with one embedded_widget channel -->
  <div id="dynamic-channels" class="inline">
    <button class="btn btn-ghost btn-sm normal-case!"
            hx-get="/channels/dimagi/chatbots/99/channels/333/edit-dialog/"
            hx-target="#channel_create_edit_modal_placeholder"
            hx-swap="innerHTML">
      <span class="tooltip" data-tip="embedded_widget"><i
          class="fa-brands fa-embedded_widget"></i> Embedded Widget</span>
    </button>
  </div>
  <!-- api-url-link hidden input renders unconditionally — this is what we scrape -->
  <input id="api-url-link" type="hidden" value="https://www.openchatstudio.com/api/openai/00000000-0000-4000-8000-000000000099/chat/completions" />
  <!-- Decoy support-widget tag — MUST NOT be matched by extractPublicId -->
  <open-chat-studio-widget chatbot-id="decafbad-0000-0000-0000-000000000000" button-text="Ask me!" position="right"></open-chat-studio-widget>
</body></html>
`;

const EDIT_HTML_WITH_PIPELINE_ID = `
<html><body>
  <div class="max-w-7xl mx-auto" id="pipelineBuilder"></div>
  <script type="module">
    window.DOCUMENTATION_BASE_URL = 'https://docs.example.com';
    document.addEventListener('DOMContentLoaded', () => {
      SiteJS.pipeline.renderPipeline("#pipelineBuilder", "dimagi", 77);
    }
    )
  </script>
</body></html>
`;

// ── Channel edit-dialog fixtures (ace#1813) ──────────────────────────
//
// Transcribed from the real upstream render path, not invented:
//   templates/chatbots/partials/channel_dialog.html
//     -> {% render_form_fields form %}   (apps/web/templatetags/form_tags.py)
//       -> templates/web/form/checkbox.html
//         -> templates/django/forms/widgets/input.html   (OCS's own override)
//
// `ChannelForm.Meta.fields` carries `enabled` + `disabled_message` since OCS
// #4202, and `ChannelForm.__init__` hangs Alpine's `x-model.boolean` off the
// checkbox and stamps `x-data={"channelEnabled": <db value>}` on the wrapper.
// Django's attrs.html emits `checked` as a BARE attribute for True and omits it
// entirely for False — that presence/absence IS the signal.
function channelEditDialogHtml(opts: { enabled: boolean }): string {
  return `
<dialog class="modal" open>
  <div class="modal-box">
    <h3 class="font-bold text-lg">Edit Embedded Widget Channel</h3>
    <form method="post" hx-post="/channels/dimagi/chatbots/99/channels/333/edit-dialog/">
      <input type="hidden" name="csrfmiddlewaretoken" value="csrf-xyz">
      ${opts.enabled ? '' : `<div role="alert" class="alert alert-warning">
        <span>This channel is disabled. Incoming messages are not processed and users receive no reply.</span>
      </div>`}
      <div x-data="{&quot;channelEnabled&quot;: ${opts.enabled}}">
        <input class="input w-full " type="text" name="name" value="ACE - Malaria Pilot" id="id_name">
        <input type="hidden" name="platform" value="embedded_widget" id="id_platform">
        <input class="checkbox " type="checkbox" name="enabled" x-model.boolean="channelEnabled" id="id_enabled"${opts.enabled ? ' checked' : ''}>
        <textarea name="disabled_message" rows="3" id="id_disabled_message" x-show="!channelEnabled"></textarea>
      </div>
      <input type="text" id="widget_token" value="tok_abcdefghijklmnop" readonly>
    </form>
  </div>
</dialog>
`;
}

const CHANNEL_DIALOG_ENABLED = channelEditDialogHtml({ enabled: true });
const CHANNEL_DIALOG_DISABLED = channelEditDialogHtml({ enabled: false });

/** The shape ace#1813 is really guarding: upstream renames or drops the field. */
const CHANNEL_DIALOG_NO_ENABLED_FIELD = CHANNEL_DIALOG_ENABLED.replace(
  'name="enabled"',
  'name="is_active"',
);

const EDIT_DIALOG_HTML_WITH_TOKEN = `
<html><body>
  <div class="card bg-base-200">
    <div class="card-body">
      <label class="label">Chatbot ID:</label>
      <div class="join w-full">
        <input type="text" id="widget_chatbot_id" value="00000000-0000-4000-8000-000000000099" class="input" readonly>
      </div>
      <label class="label">Embed Token:</label>
      <div class="join w-full">
        <input type="text" id="widget_token" value="tok-abc123" class="input" readonly>
      </div>
    </div>
  </div>
</body></html>
`;

// ── HTML scrape helpers ────────────────────────────────────────────

describe('HTML scrape helpers', () => {
  it('extractWidgetToken matches the real widget_params.html shape', () => {
    expect(extractWidgetToken(EDIT_DIALOG_HTML_WITH_TOKEN)).toBe('tok-abc123');
  });

  it('extractWidgetToken returns undefined when absent', () => {
    expect(extractWidgetToken('<html></html>')).toBeUndefined();
  });

  it('extractPublicId matches the widget tag on the chatbot home page', () => {
    expect(extractPublicId(HOME_HTML_WITH_WIDGET)).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('extractPublicId returns undefined when the widget tag is absent (flag off)', () => {
    expect(extractPublicId('<html><body><h1>no widget</h1></body></html>')).toBeUndefined();
  });

  it('extractPipelineId matches the SiteJS.pipeline.renderPipeline call', () => {
    expect(extractPipelineId(EDIT_HTML_WITH_PIPELINE_ID)).toBe(77);
  });

  it('extractPipelineId returns undefined when the script block is absent', () => {
    expect(extractPipelineId('<html></html>')).toBeUndefined();
  });

  it('extractEmbeddedWidgetChannelId finds the embedded_widget channel row', () => {
    expect(extractEmbeddedWidgetChannelId(HOME_HTML_WITH_WIDGET, 99)).toBe(333);
  });

  it('extractEmbeddedWidgetChannelId returns undefined when no embedded_widget row exists', () => {
    const htmlWithOtherChannel = `
      <button hx-get="/channels/dimagi/chatbots/99/channels/444/edit-dialog/">
        <i class="fa-brands fa-telegram"></i> Telegram
      </button>
    `;
    expect(extractEmbeddedWidgetChannelId(htmlWithOtherChannel, 99)).toBeUndefined();
  });

  it('extractExperimentIdFromLocation parses the redirect Location header', () => {
    expect(extractExperimentIdFromLocation('/a/dimagi/chatbots/99/')).toBe(99);
    expect(extractExperimentIdFromLocation('/a/dimagi/chatbots/12345/?foo=bar')).toBe(12345);
    expect(extractExperimentIdFromLocation('/some/other/path')).toBeUndefined();
  });
});

// ── assertCollectionPromptInvariant (N1 fix, 0.6.10) ────────────────

describe('assertCollectionPromptInvariant', () => {
  // OCS rule, characterized by live probe on 2026-04-28:
  // {collection_index_summaries} is required iff length >= 2.
  const VAR = '{collection_index_summaries}';

  it.each([
    ['no variable + 0 collections', `plain prompt`, [], false],
    ['no variable + 1 collection', `plain prompt`, [42], false],
    [`variable + 2 collections`, `hi ${VAR}`, [350, 365], false],
    [`variable + 3 collections`, `hi ${VAR}`, [1, 2, 3], false],
  ] as const)('accepts: %s', (_name, prompt, ids, _shouldReject) => {
    expect(() => assertCollectionPromptInvariant(prompt, ids)).not.toThrow();
  });

  it.each([
    [`variable + 0 collections`, `hi ${VAR}`, [], /2 or more/],
    [`variable + 1 collection`, `hi ${VAR}`, [42], /2 or more/],
    [`no variable + 2 collections`, `plain`, [350, 365], /Prompt expects|missing required template/],
    [`no variable + 3 collections`, `plain`, [1, 2, 3], /Prompt expects|missing required template/],
  ] as const)('rejects: %s', (_name, prompt, ids, errorMatch) => {
    expect(() => assertCollectionPromptInvariant(prompt, ids)).toThrow(errorMatch);
  });
});

// ── parseChatbotTable (N2 fix, 0.6.6) ────────────────────────────────
//
// The rows below are the PRE-#4220 shape (captured 2026-04-28); they stay
// because the parser must keep reading them. The CURRENT shape, the template
// drift that broke it, and the loud errors that now surface an unparseable
// table live in `chatbot-table-shape.test.ts` (ace#1561).

describe('parseChatbotTable', () => {
  // The /a/<team>/chatbots/table/ HTMX endpoint renders one <tr> per bot:
  //   <tr id="record-<int>" data-redirect-url="/a/<team>/chatbots/<int>/">
  //     <td><div><a href="/a/<team>/chatbots/<int>/" class="...">NAME</a></div></td>
  //     ...
  //   </tr>
  // (Anchored on the real shape captured from connect-ace on 2026-04-28.)
  const TABLE_HTML = `
    <table>
      <tbody>
        <tr id="record-12003" data-redirect-url="/a/connect-ace/chatbots/12003/">
          <td><div class="join">
            <a href="/a/connect-ace/chatbots/12003/" class="btn">
                ACE - turmeric-dogfood-20260427-v2
              </a>
          </div></td>
        </tr>
        <tr id="record-11792" data-redirect-url="/a/connect-ace/chatbots/11792/">
          <td><div class="join">
            <a href="/a/connect-ace/chatbots/11792/" class="btn">ACE Golden Template</a>
          </div></td>
        </tr>
      </tbody>
    </table>`;

  it('parses each row into a name → integer experiment_id map', () => {
    const map = parseChatbotTable(TABLE_HTML);
    expect(map.get('ACE - turmeric-dogfood-20260427-v2')).toBe(12003);
    expect(map.get('ACE Golden Template')).toBe(11792);
    expect(map.size).toBe(2);
  });

  it('returns an empty map for a body without record rows', () => {
    // The PURE parse stays non-throwing: it cannot tell an empty team from a
    // reshaped template, because it does not know the request succeeded.
    // `fetchExperimentIdsByName` is the layer that classifies the two and
    // throws `ChatbotTableShapeError` on drift — see chatbot-table-shape.test.ts.
    const map = parseChatbotTable('<html><body>no rows here</body></html>');
    expect(map.size).toBe(0);
  });

  it('trims whitespace from anchor name', () => {
    const html = `<tr id="record-99"><a href="/a/x/chatbots/99/">  spaced name  </a>`;
    expect(parseChatbotTable(html).get('spaced name')).toBe(99);
  });
});

// ── cloneChatbot ─────────────────────────────────────────────────────

describe('PlaywrightBackend.cloneChatbot', () => {
  it('handles the 302 redirect, scrapes ids, and creates the widget channel', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const request: RequestFn = async (method, url, body, options) => {
      calls.push({ method, url });

      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        // Simulate Django's redirect response
        expect(options?.followRedirects).toBe(false);
        expect(body).toMatchObject({
          new_name: 'ACE - Malaria Pilot',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          status: 200,
          text: async () => HOME_HTML_WITH_WIDGET,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_HTML_WITH_PIPELINE_ID,
          json: async () => ({}),
        };
      }
      if (
        method === 'POST' &&
        url === '/channels/dimagi/chatbots/99/channels/create-dialog/embedded_widget/'
      ) {
        expect(options?.formEncoded).toBe(true);
        expect(body).toMatchObject({
          name: 'ACE - Malaria Pilot',
          platform: 'embedded_widget',
          allow_all_domains: 'on',
          // ace#1492 — see the dedicated checkbox test below for why this is
          // load-bearing rather than cosmetic.
          enabled: 'on',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }
      // ace#1813 read-back: the channel edit-dialog, from a fresh DB read.
      if (method === 'GET' && url === '/channels/dimagi/chatbots/99/channels/333/edit-dialog/') {
        return { ok: true, status: 200, text: async () => CHANNEL_DIALOG_ENABLED, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' });

    expect(out).toEqual({
      experiment_id: 99,
      public_id: '00000000-0000-4000-8000-000000000099',
      pipeline_id: 77,
    });
    // Verify the full call sequence. The trailing two GETs are the ace#1813
    // read-back — the create POST's own 200 is not accepted as proof.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /a/dimagi/chatbots/5/copy/',
      'GET /a/dimagi/chatbots/99/',
      'GET /a/dimagi/chatbots/99/edit/',
      'POST /channels/dimagi/chatbots/99/channels/create-dialog/embedded_widget/',
      'GET /a/dimagi/chatbots/99/',
      'GET /channels/dimagi/chatbots/99/channels/333/edit-dialog/',
    ]);
  });

  /**
   * ace#1492 — the Django-checkbox trap, found by reading upstream PRs.
   *
   * OCS PR #4202 (merged 2026-08-17) added `enabled` to `ChannelForm.Meta.fields`
   * as an admin kill-switch for a channel. It is a BooleanField rendered as a
   * checkbox, and in a Django ModelForm **a checkbox absent from the POST data
   * resolves to False** — the model's `default=True` is bypassed the moment the
   * form owns the field. Channels are created through
   * `ChannelFormWrapper.save()` -> `ChannelForm.save()`, so ACE's POST, written
   * before that PR and never updated, silently created DISABLED channels.
   * `ChannelDisabledStage` then dropped every inbound message.
   *
   * What made it hard to see from this side: the golden template and every
   * pre-#4202 clone kept answering, because the migration backfilled existing
   * rows to `enabled=True`. Only NEW clones broke, and they broke with an
   * opaque generation error rather than anything naming a channel.
   *
   * This assertion is deliberately `toHaveProperty` rather than part of the
   * `toMatchObject` above: `toMatchObject` passes when a key is ABSENT, which is
   * exactly the shape of this defect, so the permissive matcher could never have
   * caught it.
   */
  it('sends enabled=on — an omitted Django checkbox means False, not the default', async () => {
    let channelBody: Record<string, unknown> | undefined;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return { ok: true, status: 200, text: async () => HOME_HTML_WITH_WIDGET, json: async () => ({}) };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return { ok: true, status: 200, text: async () => EDIT_HTML_WITH_PIPELINE_ID, json: async () => ({}) };
      }
      if (method === 'POST' && url.includes('create-dialog/embedded_widget/')) {
        channelBody = body as Record<string, unknown>;
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }
      if (method === 'GET' && url.endsWith('/channels/333/edit-dialog/')) {
        return { ok: true, status: 200, text: async () => CHANNEL_DIALOG_ENABLED, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    await makeBackend(request).cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' });

    expect(channelBody).toBeDefined();
    expect(
      channelBody,
      'The widget-channel POST must send `enabled`. Omitting it makes Django read the ' +
        'checkbox as False, so the channel is created DISABLED and every inbound message ' +
        'is dropped by ChannelDisabledStage (ace#1492, upstream OCS #4202).',
    ).toHaveProperty('enabled', 'on');
  });

  it('throws when the copy POST response has no Location header', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return { ok: false, status: 302, headers: {}, text: async () => '', json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'x' })
    ).rejects.toThrow(/did not return a Location header/);
  });

  it('throws when Location does not match the expected pattern', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/some/unexpected/path' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'x' })
    ).rejects.toThrow(/Could not parse experiment_id/);
  });
});

// ── Widget-channel enabled read-back (ace#1813) ──────────────────────

describe('classifyChannelEnabled', () => {
  it('reads a checked box as enabled', () => {
    expect(classifyChannelEnabled(CHANNEL_DIALOG_ENABLED)).toEqual({ verdict: 'enabled' });
  });

  it('reads an unchecked box as disabled — the ace#1492 signature', () => {
    expect(classifyChannelEnabled(CHANNEL_DIALOG_DISABLED)).toEqual({ verdict: 'disabled' });
  });

  it('accepts checked="checked" — HTML boolean attributes are true by presence', () => {
    const html = CHANNEL_DIALOG_ENABLED.replace(' checked>', ' checked="checked">');
    expect(classifyChannelEnabled(html)).toEqual({ verdict: 'enabled' });
  });

  /**
   * The whole point of the three-valued verdict. A renamed or dropped field is
   * NOT "enabled" — it is the exact upstream change (#4202 did it once) that
   * would also make ACE's `enabled: 'on'` POST key wrong, i.e. evidence the
   * channel is probably disabled. Collapsing this into `enabled` would rebuild
   * the silent failure the read-back exists to end.
   */
  it('reports unreadable — not enabled — when no input is named `enabled`', () => {
    const out = classifyChannelEnabled(CHANNEL_DIALOG_NO_ENABLED_FIELD);
    expect(out.verdict).toBe('unreadable');
    expect(out).toHaveProperty('detail', expect.stringContaining('no <input name="enabled">'));
  });

  it('reports unreadable when `enabled` is no longer a checkbox', () => {
    const html = CHANNEL_DIALOG_ENABLED.replace(
      '<input class="checkbox " type="checkbox" name="enabled" x-model.boolean="channelEnabled" id="id_enabled" checked>',
      '<input type="hidden" name="enabled" value="True" id="id_enabled">',
    );
    expect(classifyChannelEnabled(html).verdict).toBe('unreadable');
  });

  /**
   * Attribute VALUES must not be mistaken for the bare `checked` attribute —
   * a false positive here would report a disabled channel as enabled, which is
   * strictly worse than no detector at all.
   */
  it('does not treat the word "checked" inside an attribute value as the attribute', () => {
    const html = CHANNEL_DIALOG_DISABLED.replace(
      'x-model.boolean="channelEnabled"',
      'x-bind:class="isChecked ? \'checked box\' : \'\'" data-checked="no"',
    );
    expect(classifyChannelEnabled(html)).toEqual({ verdict: 'disabled' });
  });
});

describe('PlaywrightBackend widget-channel read-back', () => {
  /**
   * ace#1813. Before this, `createEmbeddedWidgetChannel` returned on the create
   * POST's own 200 and nothing in ACE ever read `enabled` back. That is the
   * defect: a channel born disabled (the ace#1492 class, upstream OCS #4202)
   * produces a perfectly successful POST, and since OCS #4230 only surfaces
   * later as a 403 from POST /api/chat/start/ once Phase 5 QA tries to open a
   * session. `ocs_inspect_chatbot` cannot see it either — its upstream
   * ChannelSerializer omits `enabled`.
   *
   * NEGATIVE CONTROL: run this test against the pre-fix backend (the create
   * method ending at the POST status check) and it PASSES the clone with no
   * error — no GET of the edit-dialog is even issued.
   */
  function cloneRequestFake(dialogHtml: string | null): RequestFn {
    return async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          status: 200,
          // `null` simulates a home page with no embedded_widget channel button.
          text: async () =>
            dialogHtml === null
              ? HOME_HTML_WITH_WIDGET.replace('fa-embedded_widget', 'fa-telegram')
              : HOME_HTML_WITH_WIDGET,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return { ok: true, status: 200, text: async () => EDIT_HTML_WITH_PIPELINE_ID, json: async () => ({}) };
      }
      if (method === 'POST' && url.includes('create-dialog/embedded_widget/')) {
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }
      if (method === 'GET' && url === '/channels/dimagi/chatbots/99/channels/333/edit-dialog/') {
        return { ok: true, status: 200, text: async () => dialogHtml ?? '', json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
  }

  it('halts loud when the created channel reads back DISABLED', async () => {
    const backend = makeBackend(cloneRequestFake(CHANNEL_DIALOG_DISABLED));
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' }),
    ).rejects.toThrow(WidgetChannelDisabledError);
  });

  it('names the upstream reproducers in the disabled error, not just the symptom', async () => {
    const backend = makeBackend(cloneRequestFake(CHANNEL_DIALOG_DISABLED));
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' }),
    ).rejects.toThrow(/ace#1492.*#4202[\s\S]*#4230/);
  });

  it('halts loud — not silently passes — when the enabled field cannot be found', async () => {
    const backend = makeBackend(cloneRequestFake(CHANNEL_DIALOG_NO_ENABLED_FIELD));
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' }),
    ).rejects.toThrow(WidgetChannelStateUnreadableError);
  });

  it('halts loud when the home page lists no embedded_widget channel after the create POST', async () => {
    const backend = makeBackend(cloneRequestFake(null));
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' }),
    ).rejects.toThrow(/lists no embedded_widget channel button/);
  });

  it('passes silently when the channel reads back enabled', async () => {
    const backend = makeBackend(cloneRequestFake(CHANNEL_DIALOG_ENABLED));
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' }),
    ).resolves.toMatchObject({ experiment_id: 99 });
  });
});

// ── Pipeline-patch atoms ─────────────────────────────────────────────

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

  it('attachKnowledge rejects single-collection attach when prompt has {collection_index_summaries} (N1 rule)', async () => {
    // Real OCS rule (characterized by live probe on 2026-04-28): the
    // variable is required iff collection_index_ids.length >= 2. Attaching
    // a SINGLE collection while the prompt contains the variable triggers
    // OCS's "variable is specified, but is missing" rejection.
    const fixture = loadPipelineFixture();
    const withVar = JSON.parse(JSON.stringify(fixture));
    const llmNode = withVar.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'Hello\n{collection_index_summaries}\nWorld';
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => withVar };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: withVar.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.attachKnowledge({ experiment_id: 99, collection_index_ids: [42] })
    ).rejects.toThrow(/2 or more/);
    expect(postCalled).toBe(false);
  });

  it('attachKnowledge rejects multi-collection attach when prompt LACKS the variable (N1 rule, other side)', async () => {
    const fixture = loadPipelineFixture();
    const noVar = JSON.parse(JSON.stringify(fixture));
    const llmNode = noVar.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // NO variable
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => noVar };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: noVar.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.attachKnowledge({ experiment_id: 99, collection_index_ids: [42, 43] })
    ).rejects.toThrow(/Prompt expects|missing required template/);
    expect(postCalled).toBe(false);
  });

  it('setChatbotPipeline patches prompt + collection_index_ids in a single save', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'New prompt with {collection_index_summaries}',
      collection_index_ids: [42, 43],
      max_results: 10,
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('New prompt with {collection_index_summaries}');
    expect(llm.data.params.collection_index_ids).toEqual([42, 43]);
    expect(llm.data.params.max_results).toBe(10);
  });

  it('setChatbotPipeline rejects when final prompt has {collection_index_summaries} but final collections empty', async () => {
    // Operator changes only the prompt to one with the variable, leaves
    // collections unset → final collections come from existing fixture
    // (which we'll mock as empty).
    const fixture = loadPipelineFixture();
    const stripped = JSON.parse(JSON.stringify(fixture));
    const llmNode = stripped.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // no token
    llmNode.data.params.collection_index_ids = [];
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => stripped };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: stripped.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.setChatbotPipeline({
        experiment_id: 99,
        prompt: 'Updated prompt with {collection_index_summaries}',
      })
    ).rejects.toThrow(/collection_index_summaries/);
    expect(postCalled).toBe(false);
  });

  it('setChatbotPipeline accepts variable + multi-collection in same call (canonical valid state)', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    // OCS rule: variable iff length>=2. Two collections + variable = valid.
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'New prompt with {collection_index_summaries}',
      collection_index_ids: [350, 365],
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('New prompt with {collection_index_summaries}');
    expect(llm.data.params.collection_index_ids).toEqual([350, 365]);
  });

  it('setChatbotPipeline accepts no-variable + single-collection (canonical per-opp state)', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'You are the ACE bot for opp X.',
      collection_index_ids: [365],
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.collection_index_ids).toEqual([365]);
  });

  it('setChatbotPipeline rejects multi-collection without the variable (other side of the rule)', async () => {
    const fixture = loadPipelineFixture();
    const noVar = JSON.parse(JSON.stringify(fixture));
    const llmNode = noVar.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'plain'; // no variable
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => noVar };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: noVar.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.setChatbotPipeline({
        experiment_id: 99,
        prompt: 'Still no variable',
        collection_index_ids: [42, 43],
      })
    ).rejects.toThrow(/Prompt expects|missing required template/);
    expect(postCalled).toBe(false);
  });

  it('setChatbotPipeline preserves existing collections when only prompt is changed', async () => {
    // Operator changes only the prompt; existing fixture has [42] attached.
    // Final state: prompt updated (no variable), single collection. Valid.
    const fixture = loadPipelineFixture();
    const withCollection = JSON.parse(JSON.stringify(fixture));
    const llmNode = withCollection.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.collection_index_ids = [42];

    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => withCollection };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        saved = body as typeof saved;
        return { ok: true, json: async () => ({ data: withCollection.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'Reworded plain prompt without the variable',
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('Reworded plain prompt without the variable');
    expect(llm.data.params.collection_index_ids).toEqual([42]);
  });

  it('attachKnowledge skips the pre-flight when collection_index_ids is empty (detach path)', async () => {
    // Detaching all collections is a legitimate operation (e.g. clearing a
    // wrong-domain shared collection). The token check only matters when at
    // least one collection is being attached.
    const fixture = loadPipelineFixture();
    const stripped = JSON.parse(JSON.stringify(fixture));
    const llmNode = stripped.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // no token
    let saved: unknown;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => stripped };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        saved = body;
        return { ok: true, json: async () => ({ data: stripped.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await backend.attachKnowledge({ experiment_id: 99, collection_index_ids: [] });
    expect(saved).toBeDefined();
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

  it('falls back to scraping /a/<team>/chatbots/<id>/edit/ when cache misses', async () => {
    const fixture = loadPipelineFixture();
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_HTML_WITH_PIPELINE_ID,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    // No seed — backend must resolve experiment→pipeline via the edit-page scrape
    const backend = makeBackend(request);
    await expect(
      backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'x' })
    ).resolves.toBeUndefined();
  });
});

// ── Collection atoms ─────────────────────────────────────────────────

describe('PlaywrightBackend collection atoms', () => {
  it('createCollection POSTs form-encoded and parses collection_id from redirect', async () => {
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collection/new/') {
        expect(options?.formEncoded).toBe(true);
        expect(options?.followRedirects).toBe(false);
        // is_index is the actual Django form field; llm_provider + embedding_provider_model
        // are required for indexed collections (verified 2026-04-10)
        expect(body).toMatchObject({
          name: 'ACE Malaria',
          summary: 'knowledge base',
          is_index: 'True',
          llm_provider: '378',
          embedding_provider_model: '1',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.createCollection({
      name: 'ACE Malaria',
      summary: 'knowledge base',
      is_index: true,
      is_remote_index: false,
      llm_provider: 378,
      embedding_model: 1,
    });
    expect(out.collection_id).toBe(501);
  });

  it('uploadCollectionFiles sends multipart with chunk_size + chunk_overlap and scrapes file IDs', async () => {
    // Stateful on purpose (ace#1016): the backend snapshots the listing BEFORE
    // the POST so it can diff the new rows, so the fake has to model an empty
    // collection becoming a one-row collection.
    let uploaded = false;
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        uploaded = true;
        // The atom must route through the multipart channel, not the JSON body.
        expect(body).toBeUndefined();
        expect(options?.multipart).toBeDefined();
        expect(options?.followRedirects).toBe(false);
        expect(options!.multipart!.csrfmiddlewaretoken).toBe('csrf-xyz');
        // chunk_size and chunk_overlap are required form fields (added 0.4.6);
        // without them the upload "succeeds" but produces 0 chunks and
        // retrieval silently never works.
        expect(options!.multipart!.chunk_size).toBe('800');
        expect(options!.multipart!.chunk_overlap).toBe('400');
        const fileEntry = options!.multipart!.files_0 as {
          name: string;
          mimeType: string;
          buffer: Buffer;
        };
        expect(fileEntry.name).toBe('idd.pdf');
        expect(fileEntry.mimeType).toBe('application/pdf');
        expect(fileEntry.buffer.toString()).toBe('PDF');
        // OCS returns 302 redirect to the collection home page on success.
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        // The files listing renders each upload as a wrapper div with
        // id="collection_file_<pk>" where pk is the CollectionFile PK (what
        // the status-polling endpoint requires). The anchor's File.id is
        // different and should NOT be used for status polling.
        // One page's worth of rows here; page 2+ is empty (ace#1016 pagination).
        if (url.includes('page=')) {
          return { ok: true, text: async () => '', json: async () => ({}) };
        }
        return {
          ok: true,
          text: async () =>
            uploaded
              ? `
            <div id="collection_file_34023">
              <a href="/a/dimagi/files/file/9001/">idd.pdf</a>
            </div>
          `
              : '<div id="file-list"></div>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'idd.pdf', content: Buffer.from('PDF'), mime_type: 'application/pdf' }],
    });
    // Returns CollectionFile IDs (34023), NOT File IDs (9001).
    expect(out.file_ids).toEqual([34023]);
  });

  it('uploadCollectionFiles passes custom chunk_size and chunk_overlap through the multipart', async () => {
    let uploaded = false;
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        expect(options!.multipart!.chunk_size).toBe('1200');
        expect(options!.multipart!.chunk_overlap).toBe('200');
        uploaded = true;
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        if (url.includes('page=')) {
          return { ok: true, text: async () => '', json: async () => ({}) };
        }
        return {
          ok: true,
          text: async () => (uploaded ? '<div id="collection_file_1"></div>' : ''),
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'x.pdf', content: Buffer.from('X'), mime_type: 'application/pdf' }],
      chunk_size: 1200,
      chunk_overlap: 200,
    });
  });

  // ---------------------------------------------------------------------------
  // ace#1016 — the files listing paginates at 10 rows. Reading page 1 only
  // capped `file_ids` at 10 no matter how many files were uploaded, so
  // `waitForCollectionIndexing` covered a prefix of the collection and Phase 5
  // published a bot whose remaining files may still have been unindexed. The
  // count assertion is the real preventer: it turns every future truncation
  // class (pagination, rejected extension, size cap) into a loud failure.
  // ---------------------------------------------------------------------------

  /**
   * Build a fake OCS whose files listing paginates at `perPage` rows and 404s
   * past the last page, the way Django's Paginator does.
   */
  function paginatedCollectionFake(opts: {
    preExisting: number[];
    idsAfterUpload: number[];
    perPage?: number;
  }) {
    const perPage = opts.perPage ?? 10;
    let uploaded = false;
    const seenUrls: string[] = [];
    const request: RequestFn = async (method, url) => {
      if (method === 'POST' && url.endsWith('/add_files')) {
        uploaded = true;
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/533' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/533/files/')) {
        seenUrls.push(url);
        const all = uploaded ? opts.idsAfterUpload : opts.preExisting;
        const pageMatch = url.match(/[?&]page=(\d+)/);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        const slice = all.slice((page - 1) * perPage, page * perPage);
        if (slice.length === 0 && page > 1) {
          // Django's Paginator raises Http404 for an out-of-range page.
          return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => slice.map((id) => `<div id="collection_file_${id}"></div>`).join('\n'),
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    return { request, seenUrls };
  }

  function nFiles(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      name: `doc-${i}.md`,
      content: Buffer.from('x'),
      mime_type: 'text/markdown',
    }));
  }

  it('uploadCollectionFiles follows listing pagination and returns every file id (ace#1016)', async () => {
    // The live repro: 12 files uploaded to collection 533, listing paginated
    // at 10, page 1 returned 38571–38580 and the two on page 2 were dropped.
    const ids = Array.from({ length: 12 }, (_, i) => 38571 + i);
    const { request, seenUrls } = paginatedCollectionFake({
      preExisting: [],
      idsAfterUpload: ids,
    });
    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({
      collection_id: 533,
      files: nFiles(12),
    });
    expect(out.file_ids).toEqual(ids);
    expect(out.file_ids).toHaveLength(12);
    // It actually asked for page 2 — the regression this pins.
    expect(seenUrls.some((u) => u.includes('page=2'))).toBe(true);
  });

  it('uploadCollectionFiles throws a shortfall error when the listing shows fewer new rows than files uploaded', async () => {
    // Truncation for any reason (rejected extension, size cap, a pagination
    // shape this scrape stops following) must be LOUD. It used to be silent
    // for any nonempty result.
    const { request } = paginatedCollectionFake({
      preExisting: [],
      idsAfterUpload: [1, 2, 3],
    });
    const backend = makeBackend(request);
    await expect(
      backend.uploadCollectionFiles({ collection_id: 533, files: nFiles(5) }),
    ).rejects.toThrow(/uploaded 5 file\(s\).*3 new/s);
  });

  it('uploadCollectionFiles counts only NEW rows, so a collection that already has files still passes', async () => {
    // The count assertion diffs against a pre-upload snapshot rather than
    // asserting on the absolute row count — otherwise a second upload into a
    // populated collection would false-positive.
    const preExisting = [101, 102, 103];
    const { request } = paginatedCollectionFake({
      preExisting,
      idsAfterUpload: [...preExisting, 201, 202],
      perPage: 2, // force multi-page on both the before and after snapshots
    });
    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({ collection_id: 533, files: nFiles(2) });
    expect(out.file_ids).toEqual([101, 102, 103, 201, 202]);
  });

  it('uploadCollectionFiles still throws the empty-listing error when nothing was scraped', async () => {
    const { request } = paginatedCollectionFake({ preExisting: [], idsAfterUpload: [] });
    const backend = makeBackend(request);
    await expect(
      backend.uploadCollectionFiles({ collection_id: 533, files: nFiles(1) }),
    ).rejects.toThrow(/no CollectionFile IDs scraped/);
  });

  it('uploadCollectionFiles throws if chunk_overlap >= chunk_size (Django would reject anyway)', async () => {
    const request: RequestFn = async () => {
      throw new Error('should not be called — validation must fire first');
    };
    const backend = makeBackend(request);
    await expect(
      backend.uploadCollectionFiles({
        collection_id: 501,
        files: [{ name: 'x.pdf', content: Buffer.from('X'), mime_type: 'application/pdf' }],
        chunk_size: 500,
        chunk_overlap: 500,
      }),
    ).rejects.toThrow(/chunk_overlap.*must be < chunk_size/);
  });

  it('waitForCollectionIndexing polls HTMX status partial until chunks appear', async () => {
    let call = 0;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        call++;
        const chunkCount = call >= 2 ? 5 : 0;
        const tip = chunkCount > 0 ? 'Complete' : 'In Progress';
        const html = `<div data-tip="${tip}"></div>` +
          `<div><span>${chunkCount} chunks</span></div>`;
        return { ok: true, text: async () => html, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.waitForCollectionIndexing({
      collection_id: 501,
      file_ids: [9001],
      timeout_sec: 10,
      _pollIntervalMs: 10,
    });
    expect(out.ready).toBe(true);
    expect(out.files_indexed).toBe(1);
  });

  it('waitForCollectionIndexing throws when file status is Failed', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        const html = `<div data-tip="Failed"></div><div><span>0 chunks</span></div>`;
        return { ok: true, text: async () => html, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    await expect(
      backend.waitForCollectionIndexing({
        collection_id: 501,
        file_ids: [9001],
        timeout_sec: 10,
        _pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/failed to index/);
  });

  it('waitForCollectionIndexing throws when file_ids is empty', async () => {
    const request: RequestFn = async () => {
      throw new Error('should not be called');
    };
    const backend = makeBackend(request);
    await expect(
      backend.waitForCollectionIndexing({ collection_id: 501, file_ids: [] })
    ).rejects.toThrow(/empty file_ids/);
  });
});

// ── Publish + embed info ─────────────────────────────────────────────

describe('PlaywrightBackend publish + embed info', () => {
  // publishChatbotVersion calls a pre-flight validation via /pipelines/data/
  // before POSTing /versions/create (added 0.4.6). Tests seed the experiment
  // → pipeline cache and mock the pipeline-data GET+POST as a no-error
  // round-trip so the pre-flight passes.
  const publishSeed = new Map<number, number>([[99, 77]]);

  function withPreflight(impl: RequestFn, errors: unknown = []): RequestFn {
    const fixture = loadPipelineFixture();
    return async (method, url, body, options) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors }) };
      }
      return impl(method, url, body, options);
    };
  }

  it('publishChatbotVersion pre-flights the pipeline, then POSTs versions/create as form-encoded', async () => {
    const request: RequestFn = withPreflight(async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        expect(options?.formEncoded).toBe(true);
        expect(options?.followRedirects).toBe(false);
        expect(body).toMatchObject({
          version_description: 'initial',
          is_default_version: 'on',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/#versions' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          text: async () => '<div>Version 1</div><div>Version 2</div>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const backend = makeBackend(request, publishSeed);
    const out = await backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' });
    expect(out.version_number).toBe(2);
  });

  // ── dimagi-internal/ace#1297 ────────────────────────────────────────
  // The scrape reads `Version N` badges off the chatbot home page and takes
  // the max. On spark-facilitator/20260813-2126 it returned **0** for a
  // publish that had in fact created version 2 — the page carried a literal
  // `Version 0` (a working/placeholder badge) and no higher number.
  //
  // 0 is not a version OCS can have published. Writing it into the run's
  // state file is the ace#585 fabricated-identifier class, and it later
  // breaks llo-launch's freshness equality check in a way that is very hard
  // to trace back here — the same reasoning that made the NO-badge case throw
  // instead of defaulting to 1 (#823).
  //
  // Routed into the SAME typed error, so the composite's proven #891 fallback
  // answers the question from the API instead of the markup. The publish
  // itself is never in doubt — only the read-back.
  it('publishChatbotVersion throws rather than returning an impossible version 0 (ace#1297)', async () => {
    const request: RequestFn = withPreflight(async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/#versions' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          // The live shape: a Version 0 badge and nothing higher.
          text: async () => '<div>Version 0</div><span data-public-id="pub-uuid"></span>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
  });

  it('publishChatbotVersion still returns a plausible scraped version unchanged (no extra API call)', async () => {
    // Regression guard: the fix must not turn every publish into an API
    // round-trip. A healthy badge set is still answered from the scrape.
    const request: RequestFn = withPreflight(async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        return { ok: false, status: 302, headers: {}, text: async () => '', json: async () => ({}) };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return { ok: true, text: async () => '<div>Version 0</div><div>Version 3</div>', json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const backend = makeBackend(request, publishSeed);
    const out = await backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' });
    expect(out.version_number).toBe(3);
  });

  it('publishChatbotVersion throws (does NOT silently return 1) when the home page has no `Version N` badge (jjackson/ace#823)', async () => {
    const request: RequestFn = withPreflight(async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/#versions' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        // Publish succeeded (302 above) but the home page markup drifted — no
        // `Version N` badge to scrape. Must fail loud, not return a bogus 1.
        return {
          ok: true,
          status: 200,
          text: async () => '<div>chatbot home, no version badges here</div>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
    // ace#891: still fails loud (#823's invariant), but now with a TYPED error
    // carrying the experiment_id, so the composite backend can answer the
    // question from the API instead of the caller seeing a bare HTTP failure
    // on an operation that actually succeeded.
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' }),
    ).rejects.toThrow(/publish itself succeeded/);
  });

  it('publishChatbotVersion throws when Django re-renders the form (HTTP 200 = validation failure)', async () => {
    const request: RequestFn = withPreflight(async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<form><ul class="errorlist"><li>Version description is required.</li></ul></form>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: '' }),
    ).rejects.toThrow(/Version publish rejected.*Version description is required/);
  });

  it('publishChatbotVersion throws PipelineValidationError when pre-flight finds node-level errors (catches the 2026-04-19 phantom-collection class upstream)', async () => {
    // Simulates the exact shape that hid the 2026-04-19 silent-publish-block:
    // the /pipelines/data/ save endpoint returns nested `errors.node.<id>.<field>`
    // with the real message, while /versions/create re-renders the form with no
    // errorlist. Pre-flight surfaces this before /versions/create is called.
    const request: RequestFn = withPreflight(async (method, url) => {
      // If /versions/create is reached, the test has failed — pre-flight should
      // have thrown first.
      throw new Error(`pre-flight should have blocked; got unexpected ${method} ${url}`);
    }, {
      node: {
        'LLMResponseWithPrompt-abc': {
          collection_index_ids: 'Collection index(s) with ID(s) 718 not found',
        },
      },
    });
    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: 'whatever' }),
    ).rejects.toThrow(/Pipeline save rejected.*LLMResponseWithPrompt-abc\.collection_index_ids.*718 not found/);
  });

  it('getChatbotEmbedInfo does a 3-hop scrape (home → edit-dialog → token)', async () => {
    const calls: string[] = [];
    const request: RequestFn = async (method, url) => {
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          status: 200,
          text: async () => HOME_HTML_WITH_WIDGET,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/channels/dimagi/chatbots/99/channels/333/edit-dialog/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_DIALOG_HTML_WITH_TOKEN,
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.getChatbotEmbedInfo({ experiment_id: 99 });
    expect(out.public_id).toBe('00000000-0000-4000-8000-000000000099');
    expect(out.embed_key).toBe('tok-abc123');
    expect(calls).toEqual([
      'GET /a/dimagi/chatbots/99/',
      'GET /channels/dimagi/chatbots/99/channels/333/edit-dialog/',
    ]);
  });

  it('getChatbotEmbedInfo throws with a clear message when no embedded_widget channel is present', async () => {
    const htmlNoChannel = HOME_HTML_WITH_WIDGET.replace(/fa-brands fa-embedded_widget/, 'fa-brands fa-telegram');
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return { ok: true, status: 200, text: async () => htmlNoChannel, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.getChatbotEmbedInfo({ experiment_id: 99 })
    ).rejects.toThrow(/No EMBEDDED_WIDGET channel/);
  });
});

describe('PlaywrightBackend.deleteChatbot', () => {
  it('POSTs to /a/<team>/chatbots/<pk>/delete/ with csrfmiddlewaretoken and returns deleted:1 on 302', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const request: RequestFn = async (method, url, body) => {
      calls.push({ method, url, body });
      return { ok: false, status: 302, text: async () => '', json: async () => ({}) };
    };
    const backend = makeBackend(request);
    const out = await backend.deleteChatbot({ experiment_id: 42 });
    expect(out).toEqual({ deleted: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/a/dimagi/chatbots/42/delete/',
      body: { csrfmiddlewaretoken: 'csrf-xyz' },
    });
  });

  it('accepts 200 status as success too (HTMX response)', async () => {
    const request: RequestFn = async () => ({
      ok: true, status: 200, text: async () => '', json: async () => ({}),
    });
    const backend = makeBackend(request);
    const out = await backend.deleteChatbot({ experiment_id: 42 });
    expect(out).toEqual({ deleted: 1 });
  });

  it('throws HttpError on 404 (chatbot not found)', async () => {
    const request: RequestFn = async () => ({
      ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}),
    });
    const backend = makeBackend(request);
    await expect(backend.deleteChatbot({ experiment_id: 99 })).rejects.toThrow(/404/);
  });
});

describe('PlaywrightBackend.deletePipeline', () => {
  it('issues HTTP DELETE to /a/<team>/pipelines/<pk>/delete/ and returns deleted:1 on 200', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const request: RequestFn = async (method, url) => {
      calls.push({ method, url });
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    };
    const backend = makeBackend(request);
    const out = await backend.deletePipeline({ pipeline_id: 77 });
    expect(out).toEqual({ deleted: 1 });
    expect(calls).toEqual([{ method: 'DELETE', url: '/a/dimagi/pipelines/77/delete/' }]);
  });

  it('accepts 204 No Content as success', async () => {
    const request: RequestFn = async () => ({
      ok: true, status: 204, text: async () => '', json: async () => ({}),
    });
    const backend = makeBackend(request);
    const out = await backend.deletePipeline({ pipeline_id: 77 });
    expect(out).toEqual({ deleted: 1 });
  });

  it('throws HttpError on 403 (insufficient permission)', async () => {
    const request: RequestFn = async () => ({
      ok: false, status: 403, text: async () => 'Forbidden', json: async () => ({}),
    });
    const backend = makeBackend(request);
    await expect(backend.deletePipeline({ pipeline_id: 77 })).rejects.toThrow(/403/);
  });
});

describe('PlaywrightBackend.deleteCollection', () => {
  it('issues HTTP DELETE to /a/<team>/documents/collection/<pk>/delete/ and returns deleted:1 on 200', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const request: RequestFn = async (method, url) => {
      calls.push({ method, url });
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    };
    const backend = makeBackend(request);
    const out = await backend.deleteCollection({ collection_id: 411 });
    expect(out).toEqual({ deleted: 1 });
    expect(calls).toEqual([{ method: 'DELETE', url: '/a/dimagi/documents/collection/411/delete/' }]);
  });

  it('accepts 204 No Content as success', async () => {
    const request: RequestFn = async () => ({
      ok: true, status: 204, text: async () => '', json: async () => ({}),
    });
    const backend = makeBackend(request);
    const out = await backend.deleteCollection({ collection_id: 411 });
    expect(out).toEqual({ deleted: 1 });
  });

  it('throws HttpError on 404 (collection not found)', async () => {
    const request: RequestFn = async () => ({
      ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}),
    });
    const backend = makeBackend(request);
    await expect(backend.deleteCollection({ collection_id: 999 })).rejects.toThrow(/404/);
  });
});
