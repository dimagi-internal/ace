// example_work_order.js
//
// A worked example demonstrating how to build a Dimagi-branded work order using
// the helpers in dimagi_styles.js. Copy this file, rename it for your specific
// document, and replace the content while keeping the same helper calls.
//
// Run with:
//   node example_work_order.js
//
// Produces:  ./example_work_order.docx

const fs = require('fs');
const D = require('./dimagi_styles');

// ============================================================
// CONTENT
// ============================================================

const children = [];

// --- Title block ---
children.push(D.title('Work Order Agreement #N'));
children.push(D.subtitle('Project Name — Country'));

// --- Metadata table (Pattern A) ---
children.push(D.metadataTable([
  ['Work Order Number',    'N'],
  ['Work Order Date',      'DD Month YYYY'],
  ['Work Order Title',     'Full project title goes here'],
  ['Period of Performance', 'Start date to end date'],
]));
children.push(D.spacer());

// --- Section 1 ---
children.push(D.h2('1. Background'));
children.push(D.body(
  'One or two paragraphs of context. State why this Work Order exists, what external need it ' +
  'is responding to, and what the partner is being asked to do at the highest level. Keep it ' +
  'tight — most of the substance belongs in the scope and deliverables sections below.'
));
children.push(D.richBody([
  { text: 'Define the partner once: ' },
  { text: 'PartnerName ', bold: true },
  { text: '(henceforth, referred to as "partner") is a [one-line description establishing ' +
          'why this partner is well-suited to the work].' },
]));
children.push(D.richBody([
  { text: 'This Work Order covers ' },
  { text: 'scope inclusion (e.g., field collection only)', bold: true },
  { text: '. Anything outside this scope is being arranged separately by Dimagi.' },
]));

// --- Section 2 ---
children.push(D.h2('2. Scope of Work'));
children.push(D.body('The partner will deliver [primary activity], following [protocol or specification provided by Dimagi].'));
children.push(D.body('Specifically, the partner will:'));
children.push(D.bullet('Activity 1 — what happens, how it is captured, what the output is.'));
children.push(D.bullet('Activity 2 — keep each bullet to one sentence with a clear deliverable.'));
children.push(D.bullet('Activity 3 — use the Connect app for any data capture so verification is automated.'));

children.push(D.richBody([{ text: 'The partner will not:', bold: true }]));
children.push(D.bullet('Activity outside scope #1.'));
children.push(D.bullet('Activity outside scope #2.'));

// --- Section 3 ---
children.push(D.h2('3. Geographic Coverage'));
children.push(D.richBody([
  { text: 'The partner will propose the priority states and LGAs, prioritizing ' },
  { text: 'high malaria burden', bold: true },
  { text: ' [or whatever the relevant prioritization criterion is]. Final coverage is ' +
          'jointly confirmed with Dimagi during the planning stage.' },
]));

// --- Section 4 with H3 sub-sections ---
children.push(D.h2('4. Deliverables and Verification'));

children.push(D.h3('4.1 Primary Deliverable'));
children.push(D.richBody([
  { text: 'The primary deliverable is the maximum number of ' },
  { text: 'verified [units]', bold: true },
  { text: ' that the partner can collect within the budget cap defined in Section 6, ' +
          'meeting the verification criteria in Section 4.2 below.' },
]));

children.push(D.h3('4.2 Definition of a Verified [Unit]'));
children.push(D.body('A [unit] qualifies as "verified" and is payable under this Work Order only when all of the following criteria are met:'));
children.push(D.bullet('Criterion 1: what must be true about the physical object.'));
children.push(D.bullet('Criterion 2: what data fields must be complete in the Connect app.'));
children.push(D.bullet('Criterion 3: what photographs must be captured and pass automated checks.'));
children.push(D.richBody([
  { text: '[Units] that fail one or more of these criteria are ' },
  { text: 'not payable', bold: true },
  { text: ' and will not count toward the deliverable.' },
]));

children.push(D.h3('4.3 Reporting Deliverables'));
children.push(D.bullet([
  { text: 'Weekly progress report ', bold: true },
  { text: '(lightweight, Connect dashboard export plus 1-paragraph narrative) submitted every Monday during the active period.' },
]));
children.push(D.bullet([
  { text: 'End-of-pilot summary report ', bold: true },
  { text: 'within 5 working days of the final submission, covering totals, observations, and recommendations.' },
]));

// --- Section 5 - Timeline (data table) ---
children.push(D.h2('5. Timeline and Milestones'));
children.push(D.richBody([
  { text: 'The plan below assumes contract execution by ' },
  { text: 'Friday, DD Month YYYY', bold: true },
  { text: ', with formal milestone activities commencing the following week.' },
]));
children.push(D.dataTable({
  headers: ['Week', 'Dates', 'Activities'],
  columnWidths: [1100, 1700, 6560],
  rows: [
    ['1', 'w/c DD Month', 'Activity description for week 1.'],
    ['2', 'w/c DD Month', 'Activity description for week 2.'],
    ['3', 'w/c DD Month', 'Activity description for week 3.'],
    ['4', 'w/c DD Month', 'Structured field activity begins.'],
    ['5', 'w/c DD Month', 'Full cadence; weekly reporting active.'],
    ['6', 'w/c DD Month', 'Continued activity; consolidation.'],
    ['7', 'w/c DD Month', 'Activity continues toward budget cap.'],
    ['8', 'w/c DD Month', 'End-of-pilot reporting and final reconciliation.'],
  ],
  options: {
    centerColumns: [0],
    boldColumns: [0],
    deepPurpleColumns: [0],
    headerCenterColumns: [0],
  },
}));
children.push(D.spacer());
children.push(D.body('The partner will flag any timeline risk in writing to Dimagi within 24 hours of identification.'));

// --- Section 6 - Payment Terms ---
children.push(D.h2('6. Payment Terms'));

children.push(D.h3('6.1 Total Not-to-Exceed'));
children.push(D.richBody([
  { text: 'Dimagi\u2019s total financial commitment under this Work Order is ' },
  { text: 'USD X,XXX, not-to-exceed', bold: true },
  { text: ', inclusive of all field collection costs, sample purchases, FLW compensation, ' +
          'supervision, transport, monitoring consumables, and partner reporting time.' },
]));

children.push(D.h3('6.2 Payment Schedule'));
children.push(D.dataTable({
  headers: ['#', 'Milestone', '% of Cap', 'Amount (USD)', 'Trigger / Deliverable', 'Expected Timing'],
  columnWidths: [600, 1900, 1100, 1400, 2660, 1700],
  rows: [
    ['1', 'Mobilization advance', '40%', '$1,000',
     'Contract execution + written confirmation of team readiness and state selection.',
     'w/c DD Month'],
    ['2', 'Final reconciliation', '60%', '$1,500',
     'Submission and acceptance of the end-of-pilot report; final reconciliation of verified deliverables.',
     'By DD Month'],
  ],
  options: {
    centerColumns: [0, 2, 3],
    boldColumns: [0],
    deepPurpleColumns: [0],
    headerCenterColumns: [0, 2, 3],
  },
}));
children.push(D.spacer());
children.push(D.body('Dimagi will pay only for verified deliverables.'));

// --- Section 7 - Roles and Responsibilities (data table) ---
children.push(D.h2('7. Roles and Responsibilities'));
children.push(D.dataTable({
  headers: ['Responsibility', 'Dimagi', 'Partner'],
  columnWidths: [5360, 2000, 2000],
  rows: [
    ['Protocol design (Annexure A)',           '\u2713',           'Consulted'],
    ['Connect app configuration',              '\u2713',           '\u2014'],
    ['Team recruitment, training, supervision', '\u2014',          '\u2713'],
    ['Field operations',                        '\u2014',          '\u2713'],
    ['State authority notifications',           'Supports',        '\u2713 Lead'],
    ['Data capture in Connect app',             '\u2014',          '\u2713'],
    ['Verification audit',                      '\u2713',          'Supports'],
    ['Weekly and end-of-pilot reporting',       'Reviews',         '\u2713 Produces'],
  ],
  options: {
    centerColumns: [1, 2],
    headerCenterColumns: [1, 2],
  },
}));

// --- Section 8 - Permissions, Ethics, Compliance ---
children.push(D.h2('8. Permissions, Ethics, and Compliance'));

children.push(D.h3('8.1 Permissions'));
children.push(D.body('The partner is responsible for securing all in-country permissions required to conduct the activity, including:'));
children.push(D.bullet('State Ministry of Health notification or approval in each operational state.'));
children.push(D.bullet('NMCP coordination at the state level.'));
children.push(D.bullet('Local Government Authority administrative permissions where required.'));

children.push(D.h3('8.2 Ethics'));
children.push(D.richBody([
  { text: 'This activity involves ' },
  { text: 'no patient-level data collection', bold: true },
  { text: ' and no clinical interaction with members of the public.' },
]));

// --- Closing ---
children.push(D.h2('Signatures'));
children.push(D.body(
  'IN WITNESS WHEREOF, the parties hereto have caused this Work Order to be executed by their ' +
  'authorized agents as of the date first above written, and annexed to the parties\u2019 MSA ' +
  'dated __________________.'
));
children.push(D.spacer());
children.push(D.signatureBlock({
  name: '[Partner signatory name]',
  title: '[Partner signatory title]',
  address: '[Partner address]',
}));

children.push(D.spacer());
children.push(D.h2('Annexures'));
children.push(D.bullet([
  { text: 'Annexure A: ', bold: true },
  { text: '[Annexure title] (to be provided separately by Dimagi).' },
]));

// ============================================================
// BUILD AND WRITE
// ============================================================

const doc = D.buildDocument(children, {
  creator: 'Dimagi',
  title: 'Work Order Agreement #N — Project Name',
});

D.Packer.toBuffer(doc).then(buffer => {
  const out = 'example_work_order.docx';
  fs.writeFileSync(out, buffer);
  console.log(`Wrote ${out} (${buffer.length} bytes)`);
}).catch(err => {
  console.error('Error packing document:', err);
  process.exit(1);
});
