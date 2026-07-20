import { describe, it, expect } from 'vitest';
import {
  buildHqClusterRegistry,
  inferServerFromBaseUrl,
  HqClusterNotConfiguredError,
  KNOWN_HQ_BASE_URLS,
} from '../../../../mcp/connect/hq-clusters.js';

describe('inferServerFromBaseUrl', () => {
  it('maps known hosts', () => {
    expect(inferServerFromBaseUrl('https://www.commcarehq.org')).toBe('us');
    expect(inferServerFromBaseUrl('https://eu.commcarehq.org')).toBe('eu');
    expect(inferServerFromBaseUrl('https://india.commcarehq.org')).toBe('india');
  });
  it('defaults to us for unknown/undefined', () => {
    expect(inferServerFromBaseUrl(undefined)).toBe('us');
    expect(inferServerFromBaseUrl('https://staging.commcarehq.org')).toBe('us');
  });
});

describe('buildHqClusterRegistry — back-compat (legacy bare keys only)', () => {
  it('a stock US-only .env yields exactly one us cluster, default us', () => {
    const reg = buildHqClusterRegistry({
      ACE_HQ_BASE_URL: 'https://www.commcarehq.org',
      ACE_HQ_USERNAME: 'ace@dimagi-ai.com',
      ACE_HQ_PASSWORD: 'pw',
      ACE_HQ_API_KEY: 'uskey',
      ACE_HQ_DOMAIN: 'connect-ace-prod',
    });
    expect(reg.servers()).toEqual(['us']);
    expect(reg.defaultServer).toBe('us');
    const us = reg.get();
    expect(us).toMatchObject({
      server: 'us',
      baseUrl: 'https://www.commcarehq.org',
      username: 'ace@dimagi-ai.com',
      apiKey: 'uskey',
      domain: 'connect-ace-prod',
    });
    // get() with no arg resolves the default
    expect(reg.get('us')).toBe(us);
  });

  it('bare keys pointing at EU infer an eu cluster + default eu', () => {
    const reg = buildHqClusterRegistry({
      ACE_HQ_BASE_URL: 'https://eu.commcarehq.org',
      ACE_HQ_USERNAME: 'ace@dimagi-ai.com',
      ACE_HQ_API_KEY: 'eukey',
    });
    expect(reg.servers()).toEqual(['eu']);
    expect(reg.defaultServer).toBe('eu');
    expect(reg.get().baseUrl).toBe('https://eu.commcarehq.org');
  });

  it('no HQ env at all still yields a usable default us cluster', () => {
    const reg = buildHqClusterRegistry({});
    expect(reg.defaultServer).toBe('us');
    expect(reg.get('us').baseUrl).toBe(KNOWN_HQ_BASE_URLS.us);
  });
});

describe('buildHqClusterRegistry — multi-cluster (both live at once)', () => {
  it('bare US + explicit EU block + default eu → two live clusters', () => {
    const reg = buildHqClusterRegistry({
      // legacy US block
      ACE_HQ_BASE_URL: 'https://www.commcarehq.org',
      ACE_HQ_USERNAME: 'ace@dimagi-ai.com',
      ACE_HQ_API_KEY: 'uskey',
      ACE_HQ_DOMAIN: 'connect-ace-prod',
      // new EU block (base url omitted → uses KNOWN default)
      ACE_HQ_EU_USERNAME: 'ace@dimagi-ai.com',
      ACE_HQ_EU_API_KEY: 'eukey',
      ACE_HQ_EU_DOMAIN: 'connect-ace-prod',
      ACE_HQ_DEFAULT_SERVER: 'eu',
    });
    expect(new Set(reg.servers())).toEqual(new Set(['us', 'eu']));
    expect(reg.defaultServer).toBe('eu');

    const us = reg.get('us');
    expect(us.baseUrl).toBe('https://www.commcarehq.org');
    expect(us.apiKey).toBe('uskey');

    const eu = reg.get('eu');
    expect(eu.baseUrl).toBe('https://eu.commcarehq.org'); // KNOWN default filled in
    expect(eu.apiKey).toBe('eukey');

    // default resolves to eu
    expect(reg.get()).toBe(eu);
  });

  it('explicit per-cluster block wins over a bare overlay for the same server', () => {
    const reg = buildHqClusterRegistry({
      ACE_HQ_BASE_URL: 'https://www.commcarehq.org',
      ACE_HQ_US_API_KEY: 'explicit-us-key', // explicit block
      ACE_HQ_API_KEY: 'bare-us-key', // bare overlay onto same inferred 'us'
    });
    expect(reg.get('us').apiKey).toBe('explicit-us-key');
  });

  it('ACE_HQ_DEFAULT_SERVER selects the default among several', () => {
    const reg = buildHqClusterRegistry({
      ACE_HQ_US_API_KEY: 'u',
      ACE_HQ_EU_API_KEY: 'e',
      ACE_HQ_DEFAULT_SERVER: 'eu',
    });
    expect(reg.get().server).toBe('eu');
  });

  it('throws a typed error for an unconfigured server', () => {
    const reg = buildHqClusterRegistry({ ACE_HQ_US_API_KEY: 'u' });
    expect(() => reg.get('eu')).toThrow(HqClusterNotConfiguredError);
    try {
      reg.get('eu');
    } catch (e) {
      expect((e as HqClusterNotConfiguredError).server).toBe('eu');
      expect((e as Error).message).toMatch(/ACE_HQ_EU_/);
    }
  });

  it('server arg is case-insensitive', () => {
    const reg = buildHqClusterRegistry({ ACE_HQ_EU_API_KEY: 'e', ACE_HQ_DEFAULT_SERVER: 'eu' });
    expect(reg.get('EU').server).toBe('eu');
  });
});
