// Fixture: labs workflow render_code in its PRE-FIX shape (ace#1662).
//
// Modelled on connect-labs workflow 5230 (`llo_weekly_review`) on run
// bednet-check-2-visit/20260825-1310 at render_code_version 10, plus the
// two sizing misses found on workflow 5227 at version 11.
//
// It reproduces the four ways a utility actually reaches the DOM in real
// render_code — only the first is an HTML class attribute:
//   1. a JSX className="..." attribute
//   2. a bare JS string literal assigned to a variable
//   3. a string literal inside a ternary, concatenated into className={...}
//   4. a template literal
// `text-rose-700`, the miss that started ace#1662, arrived via (3).
//
// It also carries the traps that make naive extraction wrong: an
// apostrophe in JSX text (which swallows the rest of the file if treated
// as a string delimiter), prose strings, and `data-testid` values that are
// hyphenated but are not utilities.
function WorkflowUI({ view }) {
  var people = (view && view.people) || [];

  // (2) plain string literals, never seen by a class-attribute scan
  var cardBorder = 'border-slate-300';
  var panelBorder = 'border-slate-200';

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <ul className="list-disc space-y-1 text-sm text-slate-700">
        <li>The opportunity's consent floor is 90%.</li>
        <li className="text-gray-500">Reported net use is never a target.</li>
      </ul>

      <div className={'rounded-lg border bg-white p-4 ' + cardBorder}>
        <div className={'rounded border px-3 py-2 ' + panelBorder}>
          <span data-testid="consent-floor-note" className="text-xs uppercase tracking-wide text-gray-500">
            Consent
          </span>
          {/* (3) the ace#1662 miss: a load-bearing red inside a ternary */}
          <div className={'mt-0.5 text-sm ' + (p.belowConsent ? 'font-semibold text-rose-700' : 'text-gray-800')}>
            consent 89.7% · below the 90% floor
          </div>
        </div>

        <div className="border-rose-300 bg-red-50 text-rose-800 px-3 py-2">
          This worker's consent re-affirmation is below the floor.
        </div>

        <button className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">
          On track
        </button>

        {/* (4) template literal, and the two sizing misses from 5227 */}
        <div className={`relative h-28 w-full border-gray-300`}>
          <div className="flex min-w-[52px] flex-1 flex-col">
            <span className="text-[11px] text-red-700">71.7%</span>
            <span className="text-[10px] text-red-800">28.3%</span>
          </div>
        </div>

        <div className="border-red-300 bg-emerald-500 h-8" data-testid="period-select" />
      </div>
    </div>
  );
}
