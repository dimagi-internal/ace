/**
 * Unit tests for `computeConnectMarkers` — the CCZ marker counter that
 * `commcare_download_ccz` returns to callers.
 *
 * The pre-0.10.56 implementation grepped raw zip bytes (form XML is
 * DEFLATE-compressed inside the CCZ, so the regex never matched) and
 * silently returned all zeros for every released app — see
 * `ACE/leep-paint-collection/commcare-setup-summary.md` for the
 * 2026-05-01 failure mode. Fixed by inflating in memory with fflate
 * before grepping. These tests assert the fix and lock in the regression.
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { computeConnectMarkers } from '../../../../mcp/connect/backends/commcare.js';

function buildCcz(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = strToU8(content);
  }
  return Buffer.from(zipSync(entries));
}

describe('computeConnectMarkers', () => {
  it('counts default-namespace markers (the shape Nova autobuild emits)', () => {
    // 6 modules + 6 assessments — the LEEP-paint Learn shape.
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:head><module xmlns="http://commcareconnect.com/data/v1/learn" id="m1"><name>X</name></module></h:head>',
      'modules-0/forms-1.xml':
        '<h:head><assessment xmlns="http://commcareconnect.com/data/v1/learn" id="a1"><user_score>x</user_score></assessment></h:head>',
      'modules-1/forms-0.xml':
        '<h:head><module xmlns="http://commcareconnect.com/data/v1/learn" id="m2"></module></h:head>',
      'modules-1/forms-1.xml':
        '<h:head><assessment xmlns="http://commcareconnect.com/data/v1/learn" id="a2"></assessment></h:head>',
      'suite.xml': '<suite></suite>',
    });
    expect(computeConnectMarkers(ccz)).toEqual({
      deliver: 0,
      module: 2,
      task: 0,
      assessment: 2,
    });
  });

  it('counts a single deliver_unit marker (the Deliver-app shape)', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:head><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="shop_visits"><name>Paint shop visit</name></deliver></h:head>',
      'suite.xml': '<suite></suite>',
    });
    expect(computeConnectMarkers(ccz)).toEqual({
      deliver: 1,
      module: 0,
      task: 0,
      assessment: 0,
    });
  });

  it('counts learn:-prefixed markers (legacy shape)', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:head xmlns:learn="http://commcareconnect.com/data/v1/learn"><learn:module id="m1"></learn:module><learn:task id="t1"></learn:task></h:head>',
    });
    expect(computeConnectMarkers(ccz)).toEqual({
      deliver: 0,
      module: 1,
      task: 1,
      assessment: 0,
    });
  });

  it('returns zero counts for a CCZ with no Connect markers', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:head><something_else>nope</something_else></h:head>',
      'suite.xml': '<suite></suite>',
    });
    expect(computeConnectMarkers(ccz)).toEqual({
      deliver: 0,
      module: 0,
      task: 0,
      assessment: 0,
    });
  });

  it('returns zero counts when the buffer is not a valid zip', () => {
    expect(computeConnectMarkers(Buffer.from('not a zip'))).toEqual({
      deliver: 0,
      module: 0,
      task: 0,
      assessment: 0,
    });
  });

  it('regression: would have failed pre-0.10.56 (raw bytes did not match)', () => {
    // The exact LEEP-paint Deliver shape — one deliver marker, expected to
    // be detected. Pre-0.10.56 this returned 0 because the form XML was
    // compressed inside the zip; post-fix it correctly returns 1.
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:html><h:head><h:title>Shop visit</h:title></h:head><h:body><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="shop_visits"><name>Paint shop visit</name></deliver></h:body></h:html>',
    });
    const markers = computeConnectMarkers(ccz);
    expect(markers.deliver).toBe(1);
  });
});
