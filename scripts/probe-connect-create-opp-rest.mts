// Probe whether the PR #1135 REST endpoint
// POST /api/programs/<id>/opportunities/ is live on connect.dimagi.com.
// Returns the actual HTTP status + body slice so we can decide whether to
// retry or escalate.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: '/Users/acedimagi/.ace/connect-session.json' });

// First confirm we're authenticated
const me = await ctx.request.get('https://connect.dimagi.com/accounts/login/', { maxRedirects: 0 });
console.log('login probe status', me.status(), '(expect 302 if authed, 200 if anon)');

// CSRF
const cookies = await ctx.cookies('https://connect.dimagi.com/');
const tok = cookies.find((c) => c.name === 'csrftoken')?.value ?? '';
console.log('csrf', tok.slice(0, 8));

const url = 'https://connect.dimagi.com/api/programs/cae9f0f5-84c5-40c4-9863-5b6897eb2283/opportunities/';
const res = await ctx.request.post(url, {
  data: JSON.stringify({
    name: 'probe-only-do-not-create',
    short_description: 'probe',
    description: 'probe',
    organization: 'ai-demo-space',
    start_date: '2026-06-01',
    end_date: '2026-07-31',
    total_budget: 1000,
    is_test: true,
    learn_app: {
      hq_server_url: 'https://www.commcarehq.org',
      api_key: 'd5c828dbe393096c9db45611edfdd92463586472',
      cc_domain: 'connect-ace-prod',
      cc_app_id: '4e20ddf5beca42278c4d2c20383eb943',
      description: 'probe',
      passing_score: 80,
    },
    deliver_app: {
      hq_server_url: 'https://www.commcarehq.org',
      api_key: 'd5c828dbe393096c9db45611edfdd92463586472',
      cc_domain: 'connect-ace-prod',
      cc_app_id: 'f4b4cb06962441718081a6f9ab502262',
    },
  }),
  headers: {
    'Content-Type': 'application/json',
    'X-CSRFToken': tok,
    Referer: 'https://connect.dimagi.com/a/ai-demo-space/',
  },
  maxRedirects: 0,
});
console.log('REST status', res.status());
console.log('REST headers content-type', res.headers()['content-type']);
const body = await res.text();
console.log('REST body (first 500)=', body.slice(0, 500));
await browser.close();
