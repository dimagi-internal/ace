/**
 * Draft the three LLO Directory rows (Organizations, Contacts, dates) for an EOI/RFP applicant
 * straight from its form-response row — the pure half of `scripts/llo-directory-eoi.ts`.
 *
 * Before this existed the drafting was a scratch script rewritten for each run (twice on
 * 2026-11-19), so the same applicant got slightly different notes depending on who wrote it.
 * The conventions here are the ones the 2026-11-16 and 2026-11-19 passes established:
 *
 *  - Fill a cell only from the form (nothing inferred). A founding year that is not a year, or
 *    a website field that is not a link, goes into the notes verbatim instead.
 *  - Contact `Email Address` is the address the form was submitted FROM — labs' match key — and
 *    the form's own primary-contact email is mentioned in the contact notes when it differs.
 *  - The join date is the applicant's own submission date (UTC, as the form stamps it).
 *  - HQ City stays blank; `HQ Basis` says nothing was found and that the HQ sweep is owed.
 *
 * Columns are located by header TEXT (English and French forms), never by position: the two
 * forms of one round have the same layout today, and that is a coincidence nobody promised.
 */

export interface RoundInfo {
  slug: string;
  title: string;
  announcementUrl: string;
}

export interface DraftInput {
  /** The directory's form key, e.g. `chp-rfi-2026-fr`. */
  formKey: string;
  /** 1-based row number on the response sheet (header is row 1). */
  sheetRow: number;
  header: string[];
  row: string[];
  round: RoundInfo;
  /** The day ACE writes, YYYY-MM-DD. Goes in the notes, never in a join date. */
  today: string;
  /** The owner whose standing approval covers the write. */
  approver?: string;
  /** Replaces the heuristic name/title split of "Primary contact name and title". */
  contactOverride?: { name: string; title?: string };
}

export interface DraftedRows {
  org: Record<string, string>;
  contact: Record<string, string>;
  dates: Record<string, string>;
  /** The applicant's own submission date, for `--submitted`. */
  submitted: string;
  orgName: string;
  /** Things a person should look at before the write. */
  warnings: string[];
}

const COLUMN_PATTERNS: Record<string, RegExp> = {
  timestamp: /^timestamp$/i,
  email: /^e-?mail address$/i,
  orgName: /^(organi[sz]ation name|nom de l.organisation)/i,
  founded: /(what year was your organi[sz]ation founded|en quelle année votre organisation)/i,
  contactNameTitle: /(primary contact name|nom et fonction de la personne)/i,
  contactEmail: /(primary contact email|adresse e-?mail de la personne de contact)/i,
  contactPhone: /(primary contact phone|numéro de téléphone de la personne)/i,
  website: /(website or social|site web ou page)/i,
  describes: /(which describes your organi|quelles descriptions correspondent)/i,
  registered: /(legally registered|légalement enregistrée)/i,
  budget: /(annual budget|budget annuel)/i,
  referral: /(referred by another|recommandé par une autre)/i,
  countries: /(which countries do you work|dans quels pays travaillez)/i,
  where: /(where in each country|où travaillez-vous actuellement dans chaque)/i,
  flwTeam: /(largest number of frontline|plus grand nombre d.agents de terrain)/i,
  usedConnect: /(worked with connect or commcare|déjà travaillé avec connect)/i,
};

export type ColumnIndex = Partial<Record<keyof typeof COLUMN_PATTERNS, number>>;

export function locateColumns(header: string[]): ColumnIndex {
  const out: ColumnIndex = {};
  header.forEach((title, i) => {
    const text = String(title ?? '').replace(/\s+/g, ' ').trim();
    for (const [key, re] of Object.entries(COLUMN_PATTERNS)) {
      if (out[key as keyof ColumnIndex] === undefined && re.test(text)) out[key as keyof ColumnIndex] = i;
    }
  });
  return out;
}

export const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/** French (and a few local) spellings of the countries the forms name, in the sheet's English. */
const COUNTRY_NAMES: Record<string, string> = {
  rdc: 'DRC',
  'république démocratique du congo': 'DRC',
  'republique democratique du congo': 'DRC',
  guinée: 'Guinea',
  'republique de guinée': 'Guinea',
  bénin: 'Benin',
  cameroun: 'Cameroon',
  sénégal: 'Senegal',
  'côte d’ivoire': "Côte d'Ivoire",
  "cote d'ivoire": "Côte d'Ivoire",
  inde: 'India',
  'congo-kinshasa': 'DRC',
};

export function countries(raw: string): string {
  return raw
    .split(/\s*,\s*/)
    .map(clean)
    .filter(Boolean)
    .map((c) => COUNTRY_NAMES[c.toLowerCase()] ?? c)
    .join(', ');
}

/** A usable link, normalised to https, or null (a personal LinkedIn profile is not an organisation's site). */
export function usableWebsite(raw: string): string | null {
  const w = clean(raw);
  if (!w || /\s/.test(w) || /linkedin\.com\/in\//i.test(w)) return null;
  if (/^https?:\/\//i.test(w)) return w;
  return /^(www\.)?[\w-]+(\.[\w-]+)+(\/.*)?$/.test(w) ? `https://${w}` : null;
}

/** A founding year, from "2019", "Avril 2024" or "5 février 2020"; '' for anything else. */
export function foundingYear(raw: string): string {
  const s = clean(raw);
  if (/^\d{4}$/.test(s)) return s;
  const m = s.match(/^(?:\d{1,2} )?[A-Za-zéûè]+ (\d{4})$/);
  return m ? m[1] : '';
}

const TITLE_WORDS =
  /(director|directeur|directrice|president|présid|coordinat|coordonn|manager|ceo|founder|fondat|chair|secretary|secrétaire|treasurer|trésor|head|lead|officer|responsable|promoteur|point focal|chef|administrat|executive|exécutif)/i;

/**
 * "Name, Title" / "Name - Title" / "Name (Title)" → name + title, only when the right-hand part
 * reads as a job title. Anything else stays whole in the name: splitting a name wrongly is worse
 * than leaving a title in it. Pass `contactOverride` for the rows this gets wrong.
 */
export function splitContact(raw: string): { name: string; title: string } {
  const s = clean(raw);
  for (const sep of [/\s*[,;]\s*/, /\s+[-–—]\s+/, /\s*\/\s*/, /\s*:\s*/]) {
    const parts = s.split(sep);
    if (parts.length >= 2) {
      const name = clean(parts[0]);
      const title = clean(parts.slice(1).join(', '));
      if (name && TITLE_WORDS.test(title) && !TITLE_WORDS.test(name)) return { name, title };
    }
  }
  const paren = s.match(/^(.+?)\s*\((.+)\)$/);
  if (paren && TITLE_WORDS.test(paren[2])) return { name: clean(paren[1]), title: clean(paren[2]) };
  return { name: s, title: '' };
}

/** `11/19/2026 4:40:55` (the form's UTC stamp) → { date: '2026-11-19', time: '4:40:55' }. */
export function parseStamp(raw: string): { date: string; time: string } | null {
  const m = clean(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}:\d{2}:\d{2}))?/);
  if (!m) return null;
  return { date: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, time: m[4] ?? '' };
}

const FORM_LANGUAGE: Array<[RegExp, string]> = [
  [/-fr$/i, 'French'],
  [/-en$/i, 'English'],
];

const TEMPLATE_ECHOES = [/^pays - état/i, /^état, région ou province/i];

export function draftRows(input: DraftInput): DraftedRows {
  const { formKey, sheetRow, header, row, round, today } = input;
  const approver = input.approver ?? 'Jonathan Jackson';
  const col = locateColumns(header);
  const need = (k: keyof ColumnIndex): number => {
    const i = col[k];
    if (i === undefined) throw new Error(`The response sheet for ${formKey} has no column for "${k}"; its headers changed.`);
    return i;
  };
  const get = (k: keyof ColumnIndex): string => (col[k] === undefined ? '' : String(row[col[k] as number] ?? ''));
  const warnings: string[] = [];

  const orgName = clean(row[need('orgName')]);
  if (!orgName) throw new Error(`${formKey} row ${sheetRow} has no organisation name.`);
  const stamp = parseStamp(get('timestamp'));
  if (!stamp) throw new Error(`${formKey} row ${sheetRow}: cannot read the submission time ${JSON.stringify(get('timestamp'))}.`);
  const language = FORM_LANGUAGE.find(([re]) => re.test(formKey))?.[1] ?? '';
  const formLabel = language ? `${language} form` : formKey;

  const website = usableWebsite(get('website'));
  const websiteRaw = clean(get('website'));
  const where = clean(get('where').replace(/^Zones par pays \(une ligne par région\) - /, ''));
  const regions = !where || TEMPLATE_ECHOES.some((re) => re.test(where)) || where.toLowerCase() === clean(get('countries')).toLowerCase() ? '' : where;
  const year = foundingYear(get('founded'));

  let notes = `Responded to the ${round.title} (${formKey}, response row ${sheetRow}) on ${stamp.date}.`;
  if (year) notes += ` Self-reported founding year: ${year}.`;
  else if (clean(get('founded'))) notes += ` Founding year field said: "${clean(get('founded'))}" (not a year).`;
  const facts: Array<[string, string]> = [
    [' Self-reported largest FLW team in the last five years:', get('flwTeam')],
    [" Last year's annual budget:", get('budget')],
    [' Describes itself as:', get('describes')],
    [' Registration:', get('registered')],
    [' Worked with Connect or CommCare before:', get('usedConnect')],
    [' Referral named on the form:', get('referral')],
  ];
  for (const [label, value] of facts) if (clean(value)) notes += `${label} ${clean(value)}.`;
  if (websiteRaw && !website) notes += ` Website/social field said: "${websiteRaw}" (not usable as a link).`;
  notes += ` Added by ACE under ${approver}'s standing approval for new EOI applicants, ${today}.`;

  const org: Record<string, string> = {
    'Organization Name': orgName,
    'Year of Establishment': year,
    'Countries of Operation': countries(get('countries')),
    'Regions/States of Operation': regions,
    Website: website ?? '',
    'EOIs Applied for (Add Link to EOI)': `${round.title} (${round.slug}, ${formLabel}) — ${round.announcementUrl}`,
    'Organization Notes': notes,
    'HQ Basis': `not found: no office address in the form and the website was not checked (ACE, ${today}); needs the HQ sweep`,
  };

  const split = input.contactOverride
    ? { name: input.contactOverride.name, title: input.contactOverride.title ?? '' }
    : splitContact(get('contactNameTitle'));
  if (!split.name) warnings.push('the form gives no contact name');
  const submittedFrom = clean(get('email'));
  if (!submittedFrom) warnings.push('the form has no submitting email address, which labs needs to join the contact');
  let contactNotes = `Primary contact on the ${round.title} response (${formKey}, row ${sheetRow}, ${stamp.date}). Email Address is the address the form was submitted from.`;
  const ownEmail = clean(get('contactEmail'));
  if (ownEmail && ownEmail.toLowerCase() !== submittedFrom.toLowerCase()) {
    contactNotes = contactNotes.slice(0, -1) + (ownEmail.includes('@')
      ? `; the form's primary-contact email field gave ${ownEmail}.`
      : `; the form's primary-contact email field held no email address (it said: ${ownEmail}).`);
  }
  const contact: Record<string, string> = {
    'Contact Full Name': split.name,
    'Organization Name': orgName,
    'Role / Title': split.title,
    'Main POC?': 'Yes',
    'Email Address': submittedFrom,
    'Phone Number': clean(get('contactPhone')),
    'Contact Notes (e.g. best way to contact)': contactNotes,
  };

  const dates: Record<string, string> = {
    'Organization Name': orgName,
    'Joined Connect Network': stamp.date,
    'Joined — basis': `${round.title} (${round.slug}) - exact submission timestamp`,
    Notes: `${formKey} response row ${sheetRow}, submitted ${stamp.date}${stamp.time ? ` ${stamp.time} UTC` : ''} (form timestamp). Added by ACE under ${approver}'s standing approval for new EOI applicants, ${today}.`,
  };

  const strip = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  return { org: strip(org), contact: strip(contact), dates: strip(dates), submitted: stamp.date, orgName, warnings };
}
