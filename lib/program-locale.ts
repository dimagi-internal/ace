/**
 * Country -> currency coherence for a Connect program.
 *
 * A Connect program carries `country` and `currency` as two INDEPENDENT
 * create-time fields, and nothing upstream ties them together. So a program can
 * be — and repeatedly has been — created for one country while denominating
 * every payment in another country's money. Measured live on `ai-demo-space`
 * 2026-09-16:
 *
 *   b2ca75f6  Turmeric Market Survey — turmeric-market-study (2026)
 *             country: IND   currency: USD     <- an India programme paying USD
 *   e80fce27  Turmeric Market Survey — Phase 6 capture
 *             country: IND   currency: USD
 *   e62dcb06  Turmeric Market Survey
 *             country: USA   currency: USD     <- an India study filed as USA
 *
 * Seven of the eleven turmeric programs in that org carry the same defect. The
 * money is not cosmetic: `connect_create_payment_unit`'s `amount` / `org_amount`
 * are WHOLE-currency-unit integers, so a rate authored as "1.00" against an
 * INR-denominated programme is a hundredth of the intended USD rate, and a rate
 * authored in USD against an INR programme is ~83x it. Either way the FLW-facing
 * number is wrong and `connect-program-setup-eval`'s affordability dimension
 * grades it against the wrong market floor.
 *
 * The operator's rule (2026-09-16): **the amount set up in an opportunity is
 * always in the local currency of the country selected for the opportunity.**
 * A Nigeria deployment is NGN, never USD.
 *
 * Two properties this module exists to guarantee:
 *
 *   1. `currencyForCountry` HALTS on a country it does not know. It never falls
 *      back to USD. A silent default is precisely the failure being fixed — an
 *      unknown country is a signal that the country field itself is wrong or
 *      unnormalized, and guessing hides it.
 *   2. Country is normalized to ISO 3166-1 alpha-3 before lookup, because the
 *      surfaces disagree about the format: `mcp/connect/client.ts` documents
 *      `country` as "human country name as Connect renders it (e.g. 'United
 *      States of America')" while every live row read back through
 *      `connect_list_programs` is alpha-3 (`IND`, `USA`, `BGD`). Rather than
 *      pick a winner on unverified ground, accept both and normalize.
 *      The WRITE side has since been settled (ace#2486): create matches on
 *      Connect's `Country.name`, so gate on alpha-3 but SEND
 *      `connectCountryName(alpha3)`.
 *
 * NOTE these fields are IMMUTABLE once a program exists — `connect_update_program`
 * accepts only `name/description/budget/start_date/end_date`. So this check has
 * to run BEFORE `connect_create_program`; there is no repair path afterwards,
 * only a replacement program. Per operator decision 2026-09-16 the existing
 * turmeric programs are deliberately left uncorrected (fix-forward only).
 */

/**
 * ISO 3166-1 alpha-3 -> ISO 4217 currency code.
 *
 * Deliberately NOT exhaustive: this covers the countries ACE programmes have
 * plausibly run in or been designed for. Adding a country is a one-line change;
 * an absent one halts loudly rather than defaulting, which is the point.
 */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  AFG: 'AFN', BGD: 'BDT', BEN: 'XOF', BFA: 'XOF', BDI: 'BIF', KHM: 'KHR',
  CMR: 'XAF', TCD: 'XAF', COD: 'CDF', CIV: 'XOF', EGY: 'EGP', ETH: 'ETB',
  GHA: 'GHS', GTM: 'GTQ', GIN: 'GNF', HTI: 'HTG', IND: 'INR', IDN: 'IDR',
  JOR: 'JOD', KEN: 'KES', LAO: 'LAK', LBN: 'LBP', LBR: 'LRD', MDG: 'MGA',
  MWI: 'MWK', MLI: 'XOF', MOZ: 'MZN', MMR: 'MMK', NPL: 'NPR', NER: 'XOF',
  NGA: 'NGN', PAK: 'PKR', PHL: 'PHP', RWA: 'RWF', SEN: 'XOF', SLE: 'SLE',
  SOM: 'SOS', ZAF: 'ZAR', SSD: 'SSP', SDN: 'SDG', TZA: 'TZS', THA: 'THB',
  TGO: 'XOF', UGA: 'UGX', GBR: 'GBP', USA: 'USD', VNM: 'VND', YEM: 'YER',
  ZMB: 'ZMW', ZWE: 'ZWG',
};

/**
 * Accepted spellings -> alpha-3. Covers alpha-2 and the human names Connect's
 * own country picker renders, so a PDD author writing "Nigeria" and a Connect
 * row reading "NGA" normalize to the same key.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  // alpha-2
  AF: 'AFG', BD: 'BGD', BJ: 'BEN', BF: 'BFA', BI: 'BDI', KH: 'KHM', CM: 'CMR',
  TD: 'TCD', CD: 'COD', CI: 'CIV', EG: 'EGY', ET: 'ETH', GH: 'GHA', GT: 'GTM',
  GN: 'GIN', HT: 'HTI', IN: 'IND', ID: 'IDN', JO: 'JOR', KE: 'KEN', LA: 'LAO',
  LB: 'LBN', LR: 'LBR', MG: 'MDG', MW: 'MWI', ML: 'MLI', MZ: 'MOZ', MM: 'MMR',
  NP: 'NPL', NE: 'NER', NG: 'NGA', PK: 'PAK', PH: 'PHL', RW: 'RWA', SN: 'SEN',
  SL: 'SLE', SO: 'SOM', ZA: 'ZAF', SS: 'SSD', SD: 'SDN', TZ: 'TZA', TH: 'THA',
  TG: 'TGO', UG: 'UGA', GB: 'GBR', US: 'USA', VN: 'VNM', YE: 'YEM', ZM: 'ZMB',
  ZW: 'ZWE',
  // human names (lowercased, punctuation stripped — see normalizeCountry)
  AFGHANISTAN: 'AFG', BANGLADESH: 'BGD', BENIN: 'BEN', BURKINAFASO: 'BFA',
  BURUNDI: 'BDI', CAMBODIA: 'KHM', CAMEROON: 'CMR', CHAD: 'TCD',
  DEMOCRATICREPUBLICOFTHECONGO: 'COD', DRCONGO: 'COD', CONGOKINSHASA: 'COD',
  COTEDIVOIRE: 'CIV', IVORYCOAST: 'CIV', EGYPT: 'EGY', ETHIOPIA: 'ETH',
  GHANA: 'GHA', GUATEMALA: 'GTM', GUINEA: 'GIN', HAITI: 'HTI', INDIA: 'IND',
  INDONESIA: 'IDN', JORDAN: 'JOR', KENYA: 'KEN', LAOS: 'LAO', LEBANON: 'LBN',
  LIBERIA: 'LBR', MADAGASCAR: 'MDG', MALAWI: 'MWI', MALI: 'MLI',
  MOZAMBIQUE: 'MOZ', MYANMAR: 'MMR', BURMA: 'MMR', NEPAL: 'NPL', NIGER: 'NER',
  NIGERIA: 'NGA', PAKISTAN: 'PAK', PHILIPPINES: 'PHL', THEPHILIPPINES: 'PHL',
  RWANDA: 'RWA', SENEGAL: 'SEN', SIERRALEONE: 'SLE', SOMALIA: 'SOM',
  SOUTHAFRICA: 'ZAF', SOUTHSUDAN: 'SSD', SUDAN: 'SDN', TANZANIA: 'TZA',
  UNITEDREPUBLICOFTANZANIA: 'TZA', THAILAND: 'THA', TOGO: 'TGO', UGANDA: 'UGA',
  UNITEDKINGDOM: 'GBR', UK: 'GBR', GREATBRITAIN: 'GBR',
  UNITEDSTATES: 'USA', UNITEDSTATESOFAMERICA: 'USA', VIETNAM: 'VNM',
  YEMEN: 'YEM', ZAMBIA: 'ZMB', ZIMBABWE: 'ZWE',
  // Connect's own Country.name spellings (see CONNECT_COUNTRY_NAME) that the
  // entries above do not already cover, so connectCountryName round-trips.
  LAOPEOPLESDEMOCRATICREPUBLIC: 'LAO',
  UNITEDKINGDOMOFGREATBRITAINANDNORTHERNIRELAND: 'GBR',
};

/**
 * ISO 3166-1 alpha-3 -> the `Country.name` Connect's program-create endpoint
 * matches on (ace#2486).
 *
 * The WRITE and READ surfaces disagree on format, and only the write one can
 * reject: `connect_create_program`'s serializer declares
 * `country = SlugRelatedField(slug_field="name", queryset=Country.objects.all())`
 * (`commcare_connect/program/api/serializers.py`), so alpha-3 is refused —
 * live 2026-09-26, spark-facilitator/20260925-1536 Phase 4:
 *
 *   country: 'MWI'    -> "country: Object with name=MWI does not exist."
 *   country: 'Malawi' -> created 9e82982e…, and reads back as `MWI`
 *
 * Every value below is copied from Connect's own seed data — the `COUNTRIES`
 * table in `commcare_connect/opportunity/migrations/0092_currency_country_
 * opportunity_currency_fk.py` — not from a generic ISO list, because Connect's
 * names are not the ISO short names in every case ("Ivory Coast", "Viet Nam",
 * "United Republic of Tanzania", "United Kingdom of Great Britain and Northern
 * Ireland"). Only MWI -> Malawi has been exercised against the live endpoint.
 * Keys match COUNTRY_CURRENCY exactly (pinned by test).
 */
export const CONNECT_COUNTRY_NAME: Readonly<Record<string, string>> = {
  AFG: 'Afghanistan',
  BGD: 'Bangladesh',
  BEN: 'Benin',
  BFA: 'Burkina Faso',
  BDI: 'Burundi',
  KHM: 'Cambodia',
  CMR: 'Cameroon',
  TCD: 'Chad',
  COD: 'Democratic Republic of the Congo',
  CIV: 'Ivory Coast',
  EGY: 'Egypt',
  ETH: 'Ethiopia',
  GHA: 'Ghana',
  GTM: 'Guatemala',
  GIN: 'Guinea',
  HTI: 'Haiti',
  IND: 'India',
  IDN: 'Indonesia',
  JOR: 'Jordan',
  KEN: 'Kenya',
  LAO: "Lao People's Democratic Republic",
  LBN: 'Lebanon',
  LBR: 'Liberia',
  MDG: 'Madagascar',
  MWI: 'Malawi',
  MLI: 'Mali',
  MOZ: 'Mozambique',
  MMR: 'Myanmar',
  NPL: 'Nepal',
  NER: 'Niger',
  NGA: 'Nigeria',
  PAK: 'Pakistan',
  PHL: 'Philippines',
  RWA: 'Rwanda',
  SEN: 'Senegal',
  SLE: 'Sierra Leone',
  SOM: 'Somalia',
  ZAF: 'South Africa',
  SSD: 'South Sudan',
  SDN: 'Sudan',
  TZA: 'United Republic of Tanzania',
  THA: 'Thailand',
  TGO: 'Togo',
  UGA: 'Uganda',
  GBR: 'United Kingdom of Great Britain and Northern Ireland',
  USA: 'United States of America',
  VNM: 'Viet Nam',
  YEM: 'Yemen',
  ZMB: 'Zambia',
  ZWE: 'Zimbabwe',
};

/**
 * The `country` value to SEND to `connect_create_program` for an alpha-3 code
 * (normally `checkProgramLocale(...).country`). Returns `null` for an unknown
 * code — a HALT for the caller, never a licence to send the alpha-3 or guess a
 * spelling.
 */
export function connectCountryName(alpha3: string | null | undefined): string | null {
  if (alpha3 == null) return null;
  return CONNECT_COUNTRY_NAME[alpha3.trim().toUpperCase()] ?? null;
}

/**
 * Normalize any accepted country spelling to ISO 3166-1 alpha-3, or `null` when
 * the value is not recognised. `null` is a HALT condition for every caller —
 * never a licence to pick a default.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Decompose first so diacritics are FOLDED rather than deleted: without the
  // NFD pass "Côte d'Ivoire" uppercases to "CÔTE D'IVOIRE" and the A-Z filter
  // drops the Ô entirely, yielding CTEDIVOIRE — a miss that reads as an
  // unknown country and halts a perfectly valid programme.
  const compact = raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (compact.length === 0) return null;
  if (compact in COUNTRY_CURRENCY) return compact;
  return COUNTRY_ALIASES[compact] ?? null;
}

/**
 * The ISO 4217 currency a programme in `country` must be denominated in.
 * Returns `null` for an unrecognised country — the caller HALTS and asks,
 * rather than defaulting to USD.
 */
export function currencyForCountry(country: string | null | undefined): string | null {
  const alpha3 = normalizeCountry(country);
  return alpha3 === null ? null : COUNTRY_CURRENCY[alpha3];
}

export interface LocaleVerdict {
  ok: boolean;
  /** Normalized alpha-3, or null when the country was not recognised. */
  country: string | null;
  /** The currency the country REQUIRES, or null when unknown. */
  expected: string | null;
  /** What the caller proposed, uppercased. */
  actual: string | null;
  /** Human-readable reason; empty when `ok`. */
  detail: string;
}

/**
 * Gate a proposed `{country, currency}` pair before `connect_create_program`.
 *
 * `ok: false` is a halt, not a warning. There are three distinct failures and
 * the detail distinguishes them, because the remedies differ: an unrecognised
 * country needs the country corrected or the map extended; a missing currency
 * needs one derived; a mismatched currency needs an operator decision about
 * which of the two fields is the wrong one.
 */
export function checkProgramLocale(args: {
  country: string | null | undefined;
  currency: string | null | undefined;
}): LocaleVerdict {
  const alpha3 = normalizeCountry(args.country);
  const actual = args.currency?.trim().toUpperCase() || null;

  if (alpha3 === null) {
    return {
      ok: false,
      country: null,
      expected: null,
      actual,
      detail:
        `country ${JSON.stringify(args.country ?? null)} is not a recognised ISO 3166-1 ` +
        `country. Do NOT default the currency — correct the country, or add it to ` +
        `COUNTRY_CURRENCY in lib/program-locale.ts if ACE genuinely runs there.`,
    };
  }

  const expected = COUNTRY_CURRENCY[alpha3];

  if (actual === null) {
    return {
      ok: false,
      country: alpha3,
      expected,
      actual: null,
      detail: `no currency supplied for ${alpha3}; it must be ${expected}.`,
    };
  }

  if (actual !== expected) {
    return {
      ok: false,
      country: alpha3,
      expected,
      actual,
      detail:
        `currency ${actual} does not match country ${alpha3}, which pays in ${expected}. ` +
        `An opportunity's payment amounts are always denominated in the local currency of ` +
        `its country. Decide which field is wrong — a ${actual} rate on an ${alpha3} ` +
        `programme misprices every payment unit — and fix it BEFORE create: ` +
        `connect_update_program cannot change country or currency afterwards.`,
    };
  }

  return { ok: true, country: alpha3, expected, actual, detail: '' };
}
