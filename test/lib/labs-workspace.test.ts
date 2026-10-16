/**
 * lib/labs-workspace.ts — the labs workspace settings page ACE drives in
 * clone-to-new-workspace § 4c step 6 (ace#3020). The fixtures are the
 * template's own markup (connect-labs templates/microplans/workspace_settings.html),
 * as Django renders it.
 */
import { describe, expect, it } from 'vitest';
import { parseWorkspacePage, workspaceFormBody, workspaceSettingsPath, workspaceSteps } from '../../lib/labs-workspace';

const CSRF = '<input type="hidden" name="csrfmiddlewaretoken" value="tok123">';
const NOT_YET = `<h1>Turn on workspace roles</h1><form method="post">${CSRF}
      <input type="hidden" name="action" value="turn_on">
      <button type="submit">Turn on workspace roles</button></form>`;
const llo = (slug: string) => `<form method="post" class="inline">${CSRF}
                <input type="hidden" name="action" value="remove_llo">
                <input type="hidden" name="slug" value="${slug}">
                <button type="submit">x</button></form>`;
const ADD = `<form method="post">${CSRF}<input type="hidden" name="action" value="add_llo"><input name="slug" required></form>`;
const WORKSPACE = (slugs: string[]) => `<h1>Org &mdash; access</h1>${slugs.map(llo).join('\n')}${ADD}`;

describe('labs workspace page', () => {
  it('the settings path is under microplans/', () => {
    expect(workspaceSettingsPath(10300)).toBe('/microplans/program/10300/workspace/');
  });

  it('reads "not a workspace yet" and plans turn_on + every LLO', () => {
    const s = parseWorkspacePage(NOT_YET);
    expect(s).toEqual({ is_workspace: false, llos: [] });
    expect(workspaceSteps(s, ['noora-health-pm-test', 'Noora-Health-NM-Test'])).toEqual([
      { action: 'turn_on' },
      { action: 'add_llo', slug: 'noora-health-nm-test' },
      { action: 'add_llo', slug: 'noora-health-pm-test' },
    ]);
  });

  it('reads the listed LLOs and plans only what is missing (never a removal)', () => {
    const s = parseWorkspacePage(WORKSPACE(['noora-health-nm-test', 'other-org']));
    expect(s).toEqual({ is_workspace: true, llos: ['noora-health-nm-test', 'other-org'] });
    expect(workspaceSteps(s, ['noora-health-nm-test', 'noora-health-pm-test'])).toEqual([{ action: 'add_llo', slug: 'noora-health-pm-test' }]);
    expect(workspaceSteps(parseWorkspacePage(WORKSPACE(['noora-health-nm-test', 'noora-health-pm-test'])), ['noora-health-pm-test', 'noora-health-nm-test'])).toEqual([]);
  });

  it('refuses a page that is not the settings page (a login redirect)', () => {
    expect(() => parseWorkspacePage('<html><form action="/accounts/login/"></form></html>')).toThrow(/not the labs workspace settings page/);
  });

  it('builds the urlencoded form body Django expects', () => {
    expect(workspaceFormBody('tok', 'add_llo', { slug: 'noora-health-nm-test' })).toBe('csrfmiddlewaretoken=tok&action=add_llo&slug=noora-health-nm-test');
  });
});
