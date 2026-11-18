/**
 * bin/ace-verify-links must be able to verify an ace-web run page (ace#3429).
 *
 * The public run page is a client-rendered shell: its static HTML is identical for every run
 * id, so no `--expect` could tell a real run from a wrong one and `bin/ace-email` refused every
 * reply that led with the run page. The page's data comes from
 * `/ace/api/opps/public/<ws>/<opp>/runs/<run>/summary`, which is run-specific and 404s on a
 * wrong id — that is the URL the verifier now opens.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../../bin', import.meta.url).pathname;

function contentUrl(url: string): string {
  return execFileSync(
    'python3',
    ['-c', 'import sys; from link_verification import content_url; print(content_url(sys.argv[1]))', url],
    { encoding: 'utf-8', cwd: BIN },
  ).trim();
}

describe('content_url', () => {
  it('maps the run summary page to its public data endpoint', () => {
    expect(
      contentUrl('https://labs.connect.dimagi.com/ace/opps/dimagi-team/kaduna-graduation/runs/20261112-2119/summary'),
    ).toBe(
      'https://labs.connect.dimagi.com/ace/api/opps/public/dimagi-team/kaduna-graduation/runs/20261112-2119/summary',
    );
  });

  it('keys on the run id, so a wrong-id control maps to a different (404) endpoint', () => {
    const real = contentUrl('https://labs.connect.dimagi.com/ace/opps/w/o/runs/20261112-2119/summary');
    const wrong = contentUrl('https://labs.connect.dimagi.com/ace/opps/w/o/runs/20269999-0000/summary');
    expect(real).not.toBe(wrong);
  });

  it('leaves every other URL unchanged', () => {
    const labs = 'https://labs.connect.dimagi.com/labs/workflow/12/';
    expect(contentUrl(labs)).toBe(labs);
    const workbench = 'https://labs.connect.dimagi.com/ace/w/dimagi-team/opps/o/runs/20261112-2119';
    expect(contentUrl(workbench)).toBe(workbench);
  });
});
