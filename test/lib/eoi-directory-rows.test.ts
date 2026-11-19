import { describe, expect, it } from 'vitest';
import {
  countries,
  draftRows,
  foundingYear,
  locateColumns,
  parseStamp,
  splitContact,
  usableWebsite,
} from '../../lib/eoi-directory-rows.js';

const ROUND = { slug: 'demo-rfi-2026', title: 'Demo RFI 2026', announcementUrl: 'https://example.invalid/announcement' };

// Invented data only. The English and French headers are the real forms' question openings.
const EN_HEADER = [
  'Timestamp', 'Email Address', 'Organization name', 'What year was your organization founded?',
  'Primary contact name and title', 'Primary contact email', 'Primary contact phone number',
  'Website or social media page (optional)', 'Which describes your organization? Choose all that apply.',
  'Is your organization legally registered as an independent entity in the country where you would implement?',
  'Annual budget last year in USD', 'How did you hear about this Request for Information (RFI)?',
  'If you were referred by another organization, what is the name of that organization and the contact who referred you?',
  'Which countries do you work in today? Choose all that apply', 'Where in each country do you work today?   Enter one line per state',
  'How did you choose the areas you work in today?', 'What is the largest number of frontline workers (FLWs) your organization has managed at one time',
  'Briefly describe that program', 'Could your organization manage 100 FLWs at one time?', 'Which community services have you delivered',
  'Have you worked with Connect or CommCare before?',
];
const FR_HEADER = [
  'Timestamp', 'Email Address', "Nom de l'organisation", 'En quelle année votre organisation a-t-elle été fondée ?',
  'Nom et fonction de la personne de contact principale', 'Adresse e-mail de la personne de contact principale',
  'Numéro de téléphone de la personne de contact principale', 'Site web ou page de réseaux sociaux (facultatif) ',
  'Quelles descriptions correspondent à votre organisation ? Cochez toutes les réponses applicables.',
  "Votre organisation est-elle légalement enregistrée en tant qu'entité indépendante dans le pays où vous interveniez ?",
  'Budget annuel de l’année dernière en USD', 'Comment avez-vous entendu parler de cette RFI ?',
  'Si vous avez été recommandé par une autre organisation, indiquez le nom', 'Dans quels pays travaillez-vous actuellement ?',
  'Où travaillez-vous actuellement dans chaque pays ?   Saisissez une ligne par État', 'Comment avez-vous choisi les zones',
  "Quel est le plus grand nombre d'agents de terrain que votre organisation a encadrés simultanément",
  'Décrivez brièvement ce programme', 'Votre organisation pourrait-elle gérer 100 agents', 'Quels services communautaires',
  'Avez-vous déjà travaillé avec Connect ou CommCare ?',
];

function enRow(over: Record<number, string> = {}): string[] {
  const r = [
    '11/19/2026 4:40:55', 'submitter@example.invalid', 'Acme Community Health Trust', '2019',
    'Ada Example, Executive Director', 'ada@example.invalid', '+000 111 222', 'www.acme.example.invalid',
    'Non-Governmental Organization (NGO), Women-led', 'Yes, registered', 'Under $25k', 'Website', '',
    'Nigeria', 'Nigeria - Borno State - Maiduguri - Moderate', 'need', '25-99', 'x', 'yes', 'Health', 'No',
  ];
  for (const [i, v] of Object.entries(over)) r[Number(i)] = v;
  return r;
}

describe('locateColumns', () => {
  it('finds every column in the English and the French form by header text', () => {
    for (const header of [EN_HEADER, FR_HEADER]) {
      const c = locateColumns(header);
      expect(c.timestamp).toBe(0);
      expect(c.email).toBe(1);
      expect(c.orgName).toBe(2);
      expect(c.contactNameTitle).toBe(4);
      expect(c.countries).toBe(13);
      expect(c.where).toBe(14);
      expect(c.flwTeam).toBe(16);
      expect(c.usedConnect).toBe(20);
    }
  });

  it('does not depend on position: a reordered sheet is still read correctly', () => {
    const header = [...EN_HEADER].reverse();
    const row = enRow().reverse();
    expect(draftRows({ formKey: 'demo-rfi-2026-en', sheetRow: 5, header, row, round: ROUND, today: '2026-11-20' }).orgName).toBe(
      'Acme Community Health Trust',
    );
  });
});

describe('field helpers', () => {
  it('splits a name from a title only when the right-hand side reads as a title', () => {
    expect(splitContact('Ada Example, Executive Director')).toEqual({ name: 'Ada Example', title: 'Executive Director' });
    expect(splitContact('Ada Example - Coordinatrice')).toEqual({ name: 'Ada Example', title: 'Coordinatrice' });
    expect(splitContact('Ada Example (Président fondateur)')).toEqual({ name: 'Ada Example', title: 'Président fondateur' });
    expect(splitContact('Smith, John')).toEqual({ name: 'Smith, John', title: '' }); // a surname first is not a title
    expect(splitContact('Ada Example')).toEqual({ name: 'Ada Example', title: '' });
  });

  it('accepts a link and refuses a LinkedIn profile or free text', () => {
    expect(usableWebsite('www.acme.example.invalid')).toBe('https://www.acme.example.invalid');
    expect(usableWebsite('https://acme.example.invalid/about')).toBe('https://acme.example.invalid/about');
    expect(usableWebsite('https://www.linkedin.com/in/someone')).toBeNull();
    expect(usableWebsite('Pas encore créer')).toBeNull();
    expect(usableWebsite('Yes')).toBeNull();
  });

  it('reads a founding year from a bare year or a dated phrase and from nothing else', () => {
    expect(foundingYear('2019')).toBe('2019');
    expect(foundingYear('Avril 2024')).toBe('2024');
    expect(foundingYear('5 février 2020')).toBe('2020');
    expect(foundingYear('2014 (ACS agrément) ; LUCPAMIC en 2018')).toBe('');
    expect(foundingYear('Fruscod EJE')).toBe('');
  });

  it('puts French country names in the sheet’s English', () => {
    expect(countries('RDC, Bénin, Cameroun')).toBe('DRC, Benin, Cameroon');
    expect(countries('Uganda')).toBe('Uganda');
  });

  it('reads the form’s UTC stamp', () => {
    expect(parseStamp('11/9/2026 3:53:30')).toEqual({ date: '2026-11-09', time: '3:53:30' });
    expect(parseStamp('not a date')).toBeNull();
  });
});

describe('draftRows', () => {
  const draft = (over: Record<number, string> = {}, extra = {}) =>
    draftRows({ formKey: 'demo-rfi-2026-en', sheetRow: 12, header: EN_HEADER, row: enRow(over), round: ROUND, today: '2026-11-20', ...extra });

  it('fills the three rows from the form and nothing else', () => {
    const d = draft();
    expect(d.orgName).toBe('Acme Community Health Trust');
    expect(d.submitted).toBe('2026-11-19');
    expect(d.org).toMatchObject({
      'Organization Name': 'Acme Community Health Trust',
      'Year of Establishment': '2019',
      'Countries of Operation': 'Nigeria',
      Website: 'https://www.acme.example.invalid',
      'EOIs Applied for (Add Link to EOI)': 'Demo RFI 2026 (demo-rfi-2026, English form) — https://example.invalid/announcement',
    });
    expect(Object.keys(d.org)).not.toContain('HQ City'); // never inferred
    expect(Object.keys(d.org)).not.toContain('Org Team Size');
    expect(d.org['HQ Basis']).toMatch(/^not found: .*\(ACE, 2026-11-20\); needs the HQ sweep$/);
    expect(d.org['Organization Notes']).toContain('(demo-rfi-2026-en, response row 12) on 2026-11-19.');
    expect(d.org['Organization Notes']).toContain("standing approval for new EOI applicants, 2026-11-20.");
  });

  it('dates the join by the applicant’s own submission, never by the day ACE writes', () => {
    const d = draft();
    expect(d.dates['Joined Connect Network']).toBe('2026-11-19');
    expect(d.dates['Joined Connect Network']).not.toBe('2026-11-20');
    expect(d.dates['Joined — basis']).toBe('Demo RFI 2026 (demo-rfi-2026) - exact submission timestamp');
    expect(d.dates.Notes).toContain('submitted 2026-11-19 4:40:55 UTC');
  });

  it('keeps the three organisation names identical, which is how labs joins them', () => {
    const d = draft();
    expect(d.contact['Organization Name']).toBe(d.org['Organization Name']);
    expect(d.dates['Organization Name']).toBe(d.org['Organization Name']);
  });

  it('uses the submitting address as the contact email and says when the form’s own differs', () => {
    const d = draft();
    expect(d.contact['Email Address']).toBe('submitter@example.invalid');
    expect(d.contact['Contact Full Name']).toBe('Ada Example');
    expect(d.contact['Role / Title']).toBe('Executive Director');
    expect(d.contact['Contact Notes (e.g. best way to contact)']).toContain('the form\'s primary-contact email field gave ada@example.invalid.');
  });

  it('notes a primary-contact "email" field that held a phone number instead of using it as an email', () => {
    const d = draft({ 5: '+252611020829' });
    expect(d.contact['Email Address']).toBe('submitter@example.invalid');
    expect(d.contact['Contact Notes (e.g. best way to contact)']).toContain('held no email address (it said: +252611020829)');
  });

  it('keeps a founding year that is not a year, and a website that is not a link, in the notes verbatim', () => {
    const d = draft({ 3: 'Fruscod EJE', 7: 'Yes' });
    expect(d.org['Year of Establishment']).toBeUndefined();
    expect(d.org.Website).toBeUndefined();
    expect(d.org['Organization Notes']).toContain('Founding year field said: "Fruscod EJE" (not a year).');
    expect(d.org['Organization Notes']).toContain('Website/social field said: "Yes" (not usable as a link).');
  });

  it('drops a "where" answer that only echoes the form’s template or the country', () => {
    expect(draft({ 14: 'Pays - État/Région - Districts/LGA' }).org['Regions/States of Operation']).toBeUndefined();
    expect(draft({ 14: 'Nigeria' }).org['Regions/States of Operation']).toBeUndefined();
    expect(draft().org['Regions/States of Operation']).toBe('Nigeria - Borno State - Maiduguri - Moderate');
  });

  it('drafts a French form, with its language and translated countries', () => {
    const row = enRow({ 2: 'Association Exemple', 13: 'RDC', 14: 'RDC', 9: 'Oui enregistrée', 4: 'Marie Exemple, Coordinatrice' });
    const d = draftRows({ formKey: 'demo-rfi-2026-fr', sheetRow: 9, header: FR_HEADER, row, round: ROUND, today: '2026-11-20' });
    expect(d.org['Countries of Operation']).toBe('DRC');
    expect(d.org['EOIs Applied for (Add Link to EOI)']).toContain('French form');
    expect(d.contact['Role / Title']).toBe('Coordinatrice');
  });

  it('lets a person correct the name/title split', () => {
    const d = draft({}, { contactOverride: { name: 'Ada Example', title: 'Chair' } });
    expect(d.contact['Contact Full Name']).toBe('Ada Example');
    expect(d.contact['Role / Title']).toBe('Chair');
  });

  it('refuses a row it cannot date or name rather than guessing', () => {
    expect(() => draft({ 0: 'yesterday' })).toThrow(/cannot read the submission time/);
    expect(() => draft({ 2: '  ' })).toThrow(/no organisation name/);
  });

  it('warns about a row with no submitting address, which labs could not join', () => {
    expect(draft({ 1: '' }).warnings.join(' ')).toMatch(/no submitting email/);
  });

  it('never writes a contact’s details outside the contact row', () => {
    const d = draft();
    expect(JSON.stringify(d.org)).not.toContain('submitter@example.invalid');
    expect(JSON.stringify(d.dates)).not.toContain('submitter@example.invalid');
  });
});
