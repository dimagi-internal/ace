/**
 * dimagi-internal/ace#3170: connect_create_organization. Connect's only create
 * path is the `/register/organization/` HTML form (organization_create,
 * @login_required), and there is no delete, so the atom must refuse before
 * writing when the caller already belongs to a same-named org, and must read
 * the real slug from the success redirect rather than predicting it.
 *
 * The header fixture follows dimagi/commcare-connect
 * `templates/layouts/header.html` (the org selector renders one
 * `<a href="{% url 'opportunity:list' slug %}"><p …>{{ name }}</p>` per
 * membership). The member rows are the live `org_member_table` shape (ace#1064).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { OrganizationCreateRejectedError, ConnectError } from '../../../../mcp/connect/errors.js';
import {
  djangoSlugify,
  parseHeaderMemberships,
  parseOrgSlugFromCreateRedirect,
} from '../../../../mcp/connect/backends/html-scrape.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'connect-html');
const pendingEmpty = readFileSync(join(FIXTURES, 'pending_invites_table-empty.html'), 'utf8');

const headerItem = (slug: string, name: string, shortName = '') => `
                  <li class="p-2 hover:bg-gray-100 rounded cursor-pointer text-left">
                    <a href="/a/${slug}/opportunity/">
                      <p class="text-brand-deep-purple text-sm font-medium">${name}</p>
                      ${shortName ? `<p class="text-gray-500 text-sm font-medium">${shortName}</p>` : ''}
                      <p class="text-xs text-gray-400">Program Manager</p>
                    </a>
                  </li>`;

const formPage = (...items: string[]) => `<html><body>
  <header><ul class="p-2 w-full max-h-80 overflow-y-auto">${items.join('\n')}</ul></header>
  <form action="/register/organization/" method="post" novalidate>
    <input type="hidden" name="csrfmiddlewaretoken" value="FORMCSRF">
    <input type="text" name="name" maxlength="255" required id="id_name">
  </form></body></html>`;

const rejectedPage = `<html><body><form action="/register/organization/" method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="FORMCSRF">
  <input type="text" name="name" value="ACE Test LLO (Synthetic)" class="border-red-500" id="id_name">
  <p id="error_1_id_name" class="text-red-500 text-xs italic"><strong>An organization with this name already exists.</strong></p>
</form></body></html>`;

const memberTable = (email: string, role: string) => `
  <table><thead><tr class="group"><th >select</th><th >#</th><th >member</th><th >Role</th></tr></thead>
  <tbody><tr class="odd" class="group">
    <td >
      <input type="checkbox" name="row_select" value="77" x-model="selected" @click.stop="" class="checkbox" id="row_checkbox_77" />
    </td>
    <td >
      77
    </td>
    <td >
      ${email}
    </td>
    <td >
      <div class=' underline underline-offset-4'>${role}</div>
    </td>
  </tr></tbody></table>`;

interface Call {
  method: 'GET' | 'POST';
  url: string;
  opts?: { maxRedirects?: number; form?: Record<string, string> };
}
type Scripted = { status: number; body?: string; location?: string };

function backend(responses: Scripted[], calls: Call[]): PlaywrightBackend {
  let i = 0;
  const respond = (url: string): APIResponse => {
    const r = responses[i++];
    if (!r) throw new Error(`no scripted response #${i} for ${url}`);
    return {
      status: () => r.status,
      headers: () => ({ 'content-type': 'text/html', ...(r.location ? { location: r.location } : {}) }),
      text: async () => r.body ?? '',
    } as unknown as APIResponse;
  };
  const request = {
    get: async (url: string, opts?: Call['opts']) => {
      calls.push({ method: 'GET', url, opts });
      return respond(url);
    },
    post: async (url: string, opts?: Call['opts']) => {
      calls.push({ method: 'POST', url, opts });
      return respond(url);
    },
  } as unknown as APIRequestContext;
  return new PlaywrightBackend({ baseUrl: 'https://connect.example', csrfToken: 'c', request });
}

const NAME = 'ACE Test LLO (Synthetic)';

describe('html helpers (ace#3170)', () => {
  it('djangoSlugify matches Django slugify on the shapes ACE uses', () => {
    expect(djangoSlugify(NAME)).toBe('ace-test-llo-synthetic');
    expect(djangoSlugify('  Ünïcode — Org  ')).toBe('unicode-org');
    expect(djangoSlugify('a__b  c--d')).toBe('a__b-c-d');
  });

  it('parseHeaderMemberships reads every org in the selector, decoded', () => {
    const html = formPage(headerItem('ace-pm-org', 'ACE PM Org'), headerItem('kmc-team', 'KMC &amp; Partners', 'KMC'));
    expect(parseHeaderMemberships(html)).toEqual([
      { slug: 'ace-pm-org', name: 'ACE PM Org' },
      { slug: 'kmc-team', name: 'KMC & Partners' },
    ]);
  });

  it('parseOrgSlugFromCreateRedirect accepts both success targets, relative or absolute, and nothing else', () => {
    expect(parseOrgSlugFromCreateRedirect('/a/ace-test-llo-synthetic/opportunity/')).toBe('ace-test-llo-synthetic');
    expect(parseOrgSlugFromCreateRedirect('https://connect.dimagi.com/a/x-1/organization/')).toBe('x-1');
    expect(parseOrgSlugFromCreateRedirect('/accounts/login/?next=/register/organization/')).toBeNull();
    expect(parseOrgSlugFromCreateRedirect(undefined)).toBeNull();
  });
});

describe('PlaywrightBackend.createOrganization (ace#3170)', () => {
  it('creates: GET form, POST without following redirects, slug from Location, admin read-back', async () => {
    const calls: Call[] = [];
    const out = await backend(
      [
        { status: 200, body: formPage(headerItem('ace-pm-org', 'ACE PM Org')) },
        { status: 404 },
        { status: 302, location: '/a/ace-test-llo-synthetic/opportunity/' },
        { status: 200, body: memberTable('ace@dimagi-ai.com', 'Admin') },
        { status: 200, body: pendingEmpty },
      ],
      calls,
    ).createOrganization({ name: NAME, notes: 'ACE-owned synthetic org' });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /register/organization/',
      'GET /a/ace-test-llo-synthetic/organization/member_table?page_size=100',
      'POST /register/organization/',
      'GET /a/ace-test-llo-synthetic/organization/member_table?page_size=100',
      'GET /a/ace-test-llo-synthetic/organization/pending_invites_table?page_size=100',
    ]);
    expect(calls[2].opts?.maxRedirects).toBe(0);
    expect(calls[2].opts?.form).toEqual({ csrfmiddlewaretoken: 'FORMCSRF', name: NAME, notes: 'ACE-owned synthetic org' });
    expect(out).toEqual({
      name: NAME,
      created: true,
      dry_run: false,
      existing: false,
      slug: 'ace-test-llo-synthetic',
      slug_predicted: 'ace-test-llo-synthetic',
      members: [{ email: 'ace@dimagi-ai.com', role: 'admin' }],
      admin_verified: true,
    });
  });

  it('reports the REAL slug when Connect suffixed it on a collision', async () => {
    const calls: Call[] = [];
    const out = await backend(
      [
        { status: 200, body: formPage() },
        { status: 404 },
        { status: 302, location: '/a/ace-test-llo-synthetic-1/opportunity/' },
        { status: 200, body: memberTable('ace@dimagi-ai.com', 'Admin') },
        { status: 200, body: pendingEmpty },
      ],
      calls,
    ).createOrganization({ name: NAME });
    expect(out.slug).toBe('ace-test-llo-synthetic-1');
    expect(out.slug_predicted).toBe('ace-test-llo-synthetic');
  });

  it('refuses before writing when the caller already belongs to a same-named org (case-insensitive)', async () => {
    const calls: Call[] = [];
    const out = await backend(
      [
        { status: 200, body: formPage(headerItem('ace-test-llo-synthetic', 'ace test llo (synthetic)')) },
        { status: 200, body: memberTable('ace@dimagi-ai.com', 'Admin') },
        { status: 200, body: pendingEmpty },
      ],
      calls,
    ).createOrganization({ name: NAME });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(out).toMatchObject({ created: false, existing: true, slug: 'ace-test-llo-synthetic', admin_verified: true });
  });

  it('finds an existing org the selector omits (the CURRENT org) via its admin-only member table, and posts nothing', async () => {
    const calls: Call[] = [];
    const out = await backend(
      [
        { status: 200, body: formPage(headerItem('ace-pm-org', 'ACE PM Org')) },
        { status: 200, body: memberTable('ace@dimagi-ai.com', 'Admin') },
        { status: 200, body: memberTable('ace@dimagi-ai.com', 'Admin') },
        { status: 200, body: pendingEmpty },
      ],
      calls,
    ).createOrganization({ name: NAME });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(out).toMatchObject({ created: false, existing: true, slug: 'ace-test-llo-synthetic' });
  });

  it('dry_run GETs the form only and predicts the slug', async () => {
    const calls: Call[] = [];
    const out = await backend([{ status: 200, body: formPage(headerItem('ace-pm-org', 'ACE PM Org')) }, { status: 404 }], calls)
      .createOrganization({ name: NAME, dry_run: true });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(out).toEqual({
      name: NAME,
      created: false,
      dry_run: true,
      existing: false,
      slug_predicted: 'ace-test-llo-synthetic',
    });
  });

  it('a 200 re-render is a typed rejection carrying the field errors', async () => {
    const calls: Call[] = [];
    const err = await backend(
      [{ status: 200, body: formPage() }, { status: 404 }, { status: 200, body: rejectedPage }],
      calls,
    )
      .createOrganization({ name: NAME })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrganizationCreateRejectedError);
    expect(err.toJSON()).toMatchObject({
      error: 'organization_create_rejected',
      organization_name: NAME,
      errors: ['An organization with this name already exists.'],
    });
    expect(err.name).not.toBe(NAME);
  });

  it('a redirect that is not an org URL throws instead of guessing a slug', async () => {
    const calls: Call[] = [];
    const err = await backend(
      [{ status: 200, body: formPage() }, { status: 404 }, { status: 302, location: '/accounts/login/' }],
      calls,
    )
      .createOrganization({ name: NAME })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(String(err.message)).toMatch(/not an organization URL/);
  });

  it('refuses an empty name without any request', async () => {
    const calls: Call[] = [];
    const err = await backend([], calls).createOrganization({ name: '   ' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});
