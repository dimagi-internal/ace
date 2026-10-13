/**
 * Regression suite for dimagi-internal/ace#2865 — the delivery type that had
 * NO working `delivery_type` value on either backend.
 *
 * jjackson/ace#835 reported that `connect_create_program` rejects the int FK
 * (`delivery_type: Object with slug=14 does not exist.`) and closed COMPLETED
 * by having `connect_list_delivery_types` emit `slug: slugify(name)`. That
 * derivation is a guess about a value Connect owns. It is indistinguishable
 * from a working fix for every delivery type whose real slug equals
 * `slugify(label)` — which is why it read as fixed for three months — and for
 * "Turmeric Market Study" (id 19) it produced a slug REST rejected while the
 * int was rejected too, verbatim: `delivery_type: Object with slug=19 does
 * not exist.` Phase 4 of turmeric-market-study-ghana/20261012-1749 could not
 * create its programme through the atom and needed an out-of-band workaround.
 *
 * Three predicates were each independently wrong, and each gets a block here:
 * the fabricated slug, the backend routing, and the form resolver's silent
 * empty post.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, APIResponse } from 'playwright';
import {
  parseDeliveryTypeOptions,
  normalizeDeliveryTypeLabel,
} from '../../../../mcp/connect/backends/html-scrape.js';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import {
  CompositeBackend,
  isDeliveryTypeIntFk,
} from '../../../../mcp/connect/backends/composite.js';
import { ConnectValidationError } from '../../../../mcp/connect/errors.js';
import type { ConnectClient } from '../../../../mcp/connect/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixPath = path.join(
  __dirname,
  '../../../fixtures/connect-html/a-ai-demo-space-program-init.html',
);
const programInitHtml = fs.readFileSync(fixPath, 'utf8');

describe('delivery type: the list reports only what the page states (ace#2865)', () => {
  it('carries NO slug — the form page has none to read', () => {
    // Ground truth for the premise: the whole page never says "slug".
    expect(programInitHtml).not.toMatch(/slug/i);

    const types = parseDeliveryTypeOptions(programInitHtml);
    expect(types.length).toBeGreaterThanOrEqual(13);
    expect(types.find((t) => t.name === 'Nutrition')).toEqual({ id: 13, name: 'Nutrition' });
    expect(types.find((t) => t.name === 'Infant Vaccine Promotion')).toEqual({
      id: 1,
      name: 'Infant Vaccine Promotion',
    });

    // The invention ace#835 shipped: no row may carry a fabricated slug.
    for (const t of types) {
      expect(Object.keys(t).sort()).toEqual(['id', 'name']);
    }
  });

  it('keeps the label normaliser as a LOCAL matcher', () => {
    // Still the right tool for lining ACE's own text up against a label.
    // What changed is that its output is never sent to Connect as a slug.
    expect(normalizeDeliveryTypeLabel('Turmeric Market Study')).toBe('turmeric-market-study');
  });
});

describe('delivery type: an int FK never reaches REST (ace#2865, ace#835)', () => {
  const program = (via: string) => ({
    id: 'prog-uuid',
    organization_slug: 'ai-demo-space',
    name: via,
    description: '',
    delivery_type: 19,
    budget: 110000,
    currency: 'GHS',
    country: 'Ghana',
    start_date: '2026-10-12',
    end_date: '2026-11-11',
  });

  const makeBackends = () => {
    // The REST stub stands in for the live serializer, which resolves
    // delivery_type by SLUG — so reaching it with an int is itself the defect,
    // whatever it then returns.
    const rest: Partial<ConnectClient> = { createProgram: vi.fn(async () => program('rest')) };
    const playwright: Partial<ConnectClient> = {
      createProgram: vi.fn(async () => program('playwright')),
    };
    return { rest: rest as ConnectClient, playwright: playwright as ConnectClient };
  };

  const args = (delivery_type: number | string) => ({
    organization_slug: 'ai-demo-space',
    name: 'Turmeric Market Survey (Atomic Visit) — Ghana 2026',
    description: 'd',
    delivery_type,
    budget: 110000,
    currency: 'GHS',
    country: 'Ghana',
    start_date: '2026-10-12',
    end_date: '2026-11-11',
  });

  it('routes a numeric delivery_type to the form backend', async () => {
    const { rest, playwright } = makeBackends();
    const out = await new CompositeBackend({ rest, playwright }).createProgram(args(19));
    expect(out.name).toBe('playwright');
    expect(rest.createProgram).not.toHaveBeenCalled();
  });

  it('routes a numeric-STRING delivery_type to the form backend too', async () => {
    // connect_create_program's Zod union puts z.string() first, so the wire
    // value "19" arrives as a string and means the same <option value>.
    const { rest, playwright } = makeBackends();
    const out = await new CompositeBackend({ rest, playwright }).createProgram(args('19'));
    expect(out.name).toBe('playwright');
    expect(rest.createProgram).not.toHaveBeenCalled();
  });

  it('still routes a real slug string to REST', async () => {
    const { rest, playwright } = makeBackends();
    const out = await new CompositeBackend({ rest, playwright }).createProgram(args('nutrition'));
    expect(out.name).toBe('rest');
    expect(playwright.createProgram).not.toHaveBeenCalled();
  });

  it('classifies int-FK shapes', () => {
    expect(isDeliveryTypeIntFk(19)).toBe(true);
    expect(isDeliveryTypeIntFk('19')).toBe(true);
    expect(isDeliveryTypeIntFk(' 19 ')).toBe(true);
    expect(isDeliveryTypeIntFk('nutrition')).toBe(false);
    expect(isDeliveryTypeIntFk('turmeric-market-study')).toBe(false);
  });
});

describe('delivery type: the form resolver never posts a blank (ace#2865)', () => {
  // `resolveDeliveryTypeId` is private; reach it through createProgram, its
  // only caller, and read the posted form body.
  const postedFormFor = async (delivery_type: number | string) => {
    const bodies: Record<string, string>[] = [];
    let call = 0;
    const respond = (body: string): APIResponse =>
      ({
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => body,
      }) as unknown as APIResponse;
    const request = {
      get: async () => respond(call++ === 0 ? programInitHtml : '<html></html>'),
      post: async (_url: string, init?: { form?: Record<string, string> }) => {
        bodies.push(init!.form!);
        // A re-rendered form with no errorlist reads as success; createProgram
        // then lists to find the new program, which this stub answers empty.
        return respond('<div>created</div>');
      },
    } as unknown as APIRequestContext;

    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'tok',
      request,
    });
    // The post-create lookup is irrelevant here and will not find the program;
    // swallow that so the assertion is about the POSTED body only.
    await backend
      .createProgram({
        organization_slug: 'ai-demo-space',
        name: 'x',
        description: 'd',
        delivery_type,
        budget: 1,
        currency: 'GHS',
        country: 'Ghana',
        start_date: '2026-10-12',
        end_date: '2026-11-11',
      })
      .catch((err) => {
        // A delivery-type refusal must still reach the caller.
        if (err instanceof ConnectValidationError) throw err;
      });
    return bodies[0];
  };

  it('resolves a hyphenated, slug-shaped string against the labels', async () => {
    // The old resolver compared "infant-vaccine-promotion" against
    // "infant vaccine promotion" by === and then .includes(), matched
    // neither, and posted ''. That shape is exactly what a PDD's
    // connect_delivery_type holds and what the old list atom returned.
    expect((await postedFormFor('infant-vaccine-promotion')).delivery_type).toBe('1');
  });

  it('still resolves a plain display name', async () => {
    expect((await postedFormFor('Nutrition')).delivery_type).toBe('13');
  });

  it('passes an int straight through', async () => {
    expect((await postedFormFor(19)).delivery_type).toBe('19');
  });

  it('THROWS rather than posting an empty delivery_type on a miss', async () => {
    await expect(postedFormFor('no-such-delivery-type')).rejects.toBeInstanceOf(
      ConnectValidationError,
    );
  });

  it('names the available ids in the refusal so the caller can act', async () => {
    await expect(postedFormFor('no-such-delivery-type')).rejects.toThrow(/13=Nutrition/);
  });

  it('posts nothing at all when the delivery type cannot be resolved', async () => {
    // The regression this replaces: a resolution MISS used to become
    // `delivery_type: ''` on a live create of a field that is create-time-only.
    const bodies: Record<string, string>[] = [];
    const request = {
      get: async () =>
        ({
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html' }),
          text: async () => programInitHtml,
        }) as unknown as APIResponse,
      post: async (_url: string, init?: { form?: Record<string, string> }) => {
        bodies.push(init!.form!);
        throw new Error('must not POST');
      },
    } as unknown as APIRequestContext;
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'tok',
      request,
    });
    await expect(
      backend.createProgram({
        organization_slug: 'ai-demo-space',
        name: 'x',
        description: 'd',
        delivery_type: 'no-such-delivery-type',
        budget: 1,
        currency: 'GHS',
        country: 'Ghana',
        start_date: '2026-10-12',
        end_date: '2026-11-11',
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
    expect(bodies).toEqual([]);
  });
});
