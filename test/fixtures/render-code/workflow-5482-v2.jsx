function WorkflowUI({ definition, instance, links, actions, onUpdateState, view }) {
    // PDD §8.1 P1: verified meeting rate >= 85% across the cohort.
    var TARGET_PCT = 85;
    var workers = view.workers || [];
    var rows = (view.pipelines.flw_kpis && view.pipelines.flw_kpis.rows) || [];
    var isCompleted = view.isCompleted;

    var byUser = {};
    rows.forEach(function (r) { byUser[r.username] = r; });

    var pct = function (n, d) { return d > 0 ? (100 * n) / d : null; };
    var fmt = function (v, dp) { return v == null ? "—" : Number(v).toFixed(dp == null ? 1 : dp); };
    var numOrNull = function (v) { return v == null ? null : Number(v); };

    var table = workers.map(function (w) {
        var r = byUser[w.username] || {};
        var records = Number(r.records || 0);
        var payable = Number(r.payable || 0);
        var maleAtt = numOrNull(r.avg_male_attendance);
        var femaleAtt = numOrNull(r.avg_female_attendance);
        var maleSpoke = numOrNull(r.avg_male_participants);
        var femaleSpoke = numOrNull(r.avg_female_participants);
        var attendance = (maleAtt == null || femaleAtt == null) ? null : maleAtt + femaleAtt;
        var spoke = (maleSpoke == null || femaleSpoke == null) ? null : maleSpoke + femaleSpoke;
        return {
            username: w.username,
            name: w.name || w.username,
            village: r.community || "—",
            records: records,
            payable: payable,
            committee: Number(r.committee || 0),
            notHeld: Number(r.not_held || 0),
            review: Number(r.flagged_visits || 0),
            steps: r.steps_covered == null ? null : Number(r.steps_covered),
            stepsClosed: r.steps_completed == null ? null : Number(r.steps_completed),
            attendance: attendance,
            spokePct: (attendance != null && spoke != null && attendance > 0) ? (100 * spoke) / attendance : null,
            payPct: pct(payable, records)
        };
    }).sort(function (a, b) { return (a.payPct == null ? 999 : a.payPct) - (b.payPct == null ? 999 : b.payPct); });

    var totals = table.reduce(function (acc, t) {
        acc.records += t.records; acc.payable += t.payable;
        acc.committee += t.committee; acc.notHeld += t.notHeld; acc.review += t.review;
        return acc;
    }, { records: 0, payable: 0, committee: 0, notHeld: 0, review: 0 });
    var earnsNothing = totals.records - totals.payable;
    var programmeRate = pct(totals.payable, totals.records);
    var below = table.filter(function (t) { return t.payPct != null && t.payPct < TARGET_PCT; });

    // Records - Payable = Committee + Did not happen, so those two are the only
    // causes of a shortfall and the parts always sum to the gap. Records held
    // for review are a separate observation and never a cause: they do not
    // change whether a record earned a payment.
    var whyShort = function (t) {
        var parts = [];
        if (t.committee > 0) parts.push(t.committee + " were committee meetings");
        if (t.notHeld > 0) parts.push(t.notHeld + " were meetings that did not happen");
        return { gap: t.records - t.payable, parts: parts, review: t.review };
    };

    var card = function (value, label, sub, tone) {
        var tones = {
            plain: "bg-white",
            good: "bg-green-50 border border-green-200",
            warn: "bg-yellow-50 border border-yellow-200",
            info: "bg-blue-50 border border-blue-200"
        };
        return (
            <div className={"p-4 rounded-lg shadow-sm " + (tones[tone] || tones.plain)}>
                <div className="text-3xl font-bold text-gray-900">{value}</div>
                <div className="text-gray-600 text-sm">{label}</div>
                <div className="text-gray-500 text-xs">{sub}</div>
            </div>
        );
    };

    var th = function (label, sub, align) {
        return (
            <th className={"px-3 py-2 font-medium text-gray-600 " + (align === "left" ? "text-left" : "text-right")}>
                {label}
                <span className="block text-xs font-normal text-gray-500">{sub}</span>
            </th>
        );
    };

    return (
        <div className="space-y-4">
            <div className="bg-white rounded-lg shadow-sm p-4">
                <div className="flex flex-wrap justify-between items-center gap-3">
                    <div>
                        <h1 className="text-xl font-semibold text-gray-900">What the pilot pays for, and what it does not</h1>
                        <div className="text-sm text-gray-500">
                            Every meeting record a facilitator filed in the Goal Setting window, and whether it earned a payment.
                            {view.asOf ? " As of " + String(view.asOf).replace("T", " ").slice(0, 16) + " UTC" : ""}
                        </div>
                    </div>
                    {isCompleted && (
                        <span className="px-2 py-1 rounded text-sm bg-gray-100 text-gray-700">Completed — read only</span>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {card(totals.records, "Meeting records filed", "one per meeting occasion", "plain")}
                {card(totals.payable, "Earned a payment", "meeting happened, community meeting", "good")}
                {card(earnsNothing, "Recorded, earned nothing", totals.committee + " committee, " + totals.notHeld + " did not happen", "info")}
                {card(fmt(programmeRate) + "%", "Share that earned a payment", "target 85%", programmeRate != null && programmeRate >= TARGET_PCT ? "good" : "warn")}
                {card(below.length + " of " + table.length, "Facilitators below the target", "and why is shown below", below.length ? "warn" : "good")}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                <div className="text-sm text-gray-700">
                    <span className="font-semibold text-gray-900">The payment test.</span>{" "}
                    A record earns a payment when it says the meeting happened
                    <span className="font-semibold"> and </span>
                    that it was a community meeting. Everything else is recorded and earns nothing: a committee meeting is
                    real facilitation work but is not the unit this pilot pays for, and a meeting that did not happen is
                    still filed, with a reason, so the programme can see it.
                </div>
                <div className="text-xs text-gray-500 mt-2">
                    This pilot has no agreed per-meeting rate. The design routes the rate to the solicitation response,
                    so this page counts meetings, not money.
                </div>
                <div className="text-xs text-gray-600 mt-3 border-t border-gray-100 pt-2">
                    <span className="font-semibold text-gray-700">How the columns fit together.</span>{" "}
                    Records filed − committee meetings − meetings that did not happen = earned a payment, and the share is
                    that number divided by records filed. <span className="font-medium">Held for review</span> is a separate
                    data question — a repeated entity key, a late submission, a poor location fix — and it changes no figure
                    on this page. <span className="font-medium">Steps covered</span> and{" "}
                    <span className="font-medium">steps closed out</span> report how far each community has moved through the
                    seven Goal Setting steps; the design reports progression and never prices it.
                </div>
            </div>

            {below.length > 0 && (
                <div className="bg-white rounded-lg shadow-sm p-4" data-testid="shortfall-panel">
                    <h2 className="text-sm font-semibold text-gray-900 mb-2">Why each facilitator sits below the 85% target</h2>
                    <ul className="space-y-1 text-sm text-gray-700">
                        {below.map(function (t) {
                            var c = whyShort(t);
                            return (
                                <li key={t.username}>
                                    <span className="font-semibold text-gray-900">{t.name}</span>
                                    <span className="text-gray-500"> · {t.village} · </span>
                                    <span className="tabular-nums">{fmt(t.payPct)}%</span>
                                    <span className="text-gray-500"> — {c.gap} of {t.records} records earned nothing: {c.parts.join(", ")}</span>
                                    {c.review > 0 && (
                                        <span className="text-gray-600"> · separately, {c.review} records held for review — a data question, not part of this shortfall</span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            <div className="bg-white rounded-lg shadow-sm overflow-x-auto" data-testid="ledger-table">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                        <tr>
                            {th("Facilitator", "one per community", "left")}
                            {th("Community", "synthetic name", "left")}
                            {th("Records filed", "meeting occasions")}
                            {th("Earned a payment", "happened, community meeting")}
                            {th("Committee meetings", "real work, earns nothing")}
                            {th("Did not happen", "filed with a reason, earns nothing")}
                            {th("Share that earned a payment", "target 85%")}
                            {th("Held for review", "a data question, not a pay decision")}
                            {th("Steps covered", "of the 7 Goal Setting steps")}
                            {th("Steps closed out", "reported, never priced")}
                            {th("Attendance", "mean people per meeting")}
                            {th("Spoke", "share of those attending")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {table.length === 0 && (
                            <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-500">No facilitators on this opportunity yet.</td></tr>
                        )}
                        {table.map(function (t) {
                            var under = t.payPct != null && t.payPct < TARGET_PCT;
                            return (
                                <tr key={t.username} className={under ? "bg-yellow-50" : "hover:bg-gray-50"}>
                                    <td className="px-3 py-2 text-gray-900">{t.name}</td>
                                    <td className="px-3 py-2 text-gray-700">{t.village}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.records}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-900 font-semibold">{t.payable}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.committee}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.notHeld}</td>
                                    <td className={"px-3 py-2 text-right tabular-nums " + (under ? "text-yellow-800 font-semibold" : "text-gray-700")}>{fmt(t.payPct)}%</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.review}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.steps == null ? "—" : t.steps}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{t.stepsClosed == null ? "—" : t.stepsClosed}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(t.attendance, 0)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(t.spokePct, 0)}%</td>
                                </tr>
                            );
                        })}
                    </tbody>
                    {table.length > 0 && (
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300" data-testid="ledger-totals">
                            <tr>
                                <td className="px-3 py-2 font-semibold text-gray-900">All facilitators</td>
                                <td className="px-3 py-2 text-gray-600">{table.length} in the cohort</td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{totals.records}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{totals.payable}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{totals.committee}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{totals.notHeld}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{fmt(programmeRate)}%</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{totals.review}</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-500">—</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-500">—</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-500">—</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-500">—</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4 text-xs text-gray-500">
                Every facilitator, community and figure on this page is synthetic. No Spark data is shown, and no district,
                Traditional Authority or community has been selected — the design routes that choice to the responding
                organisation.
            </div>
        </div>
    );
}
