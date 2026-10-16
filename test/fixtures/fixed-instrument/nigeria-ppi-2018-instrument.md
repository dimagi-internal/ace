# INSTRUMENT — Nigeria 2018 PPI® (official, extracted verbatim)

**Source:** official Nigeria PPI 2020 workbook from povertyindex.org (`Nigeria 2018 PPI®_Scorecards+Look-Up Tables - Updated.xlsx`), filed under `inputs/official-nigeria-ppi-2020 (povertyindex.org)/`. Built on the Nigeria Living Standards Survey 2018 (NLSS), published Oct 2020 — the current Nigeria PPI. Extracted programmatically from the workbook (not transcribed). License permits digitizing the ten questions and lookup tables into an application **unmodified**.

This is the FIXED instrument for the Household Poverty Targeting Survey. The app must present these ten questions verbatim, score responses using the point values below, sum to a PPI score (0-100), then convert the score to a poverty likelihood via the lookup table. **Default poverty line: National Poverty Line** (the standard PPI default). The source workbook also carries point columns + lookup tables for 17 other poverty lines ($2.15/day, $3.65/day, $1.90/day 2011 PPP, percentile bands, etc.) — see the xlsx if a different line is ever required.

## Scorecard — 10 indicators (points = National Poverty Line)

| # | Indicator | Response | Points |
|---|-----------|----------|-------:|
| 1 | In which zone does the household live? | A. North Central | 10 |
|  |  | B. North East | 0 |
|  |  | C. North West | 2 |
|  |  | D. South East | 0 |
|  |  | E. South South | 10 |
|  |  | F. South West | 16 |
| 2 | How many members are there in the household? | A. 3 or less | 31 |
|  |  | B. 4-6 | 10 |
|  |  | C. More than 6 | 0 |
| 3 | Within the past 7 days, did any members of your household eat any BREAD within the household? | A.Yes | 9 |
|  |  | B. No | 0 |
| 4 | Within the past 7 days, did any members of your household eat any EGGS within the household? | A.Yes | 10 |
|  |  | B. No | 0 |
| 5 | Within the past 7 days, did any members of your household drink any MILK within the household? | A.Yes | 6 |
|  |  | B. No | 0 |
| 6 | Within the past 7 days, did any members of your household drink any SACHET WATER within the household? | A.Yes | 6 |
|  |  | B. No | 0 |
| 7 | Over the past 30 days, did your household purchase or pay for any ELECTRICITY (including electricity vouchers)? | A.Yes | 5 |
|  |  | B. No | 0 |
| 8 | Does your household own a sofa? | A.Yes | 8 |
|  |  | B. No | 0 |
| 9 | Does your household own an FAN? | A.Yes | 5 |
|  |  | B. No | 0 |
| 10 | Does your household own an IRON? | A.Yes | 6 |
|  |  | B. No | 0 |

Scoring: for each of the 10 indicators, record the household's response and its point value (National Poverty Line column). Sum all 10 → **PPI score, 0-100**. Every 'No' / absent response scores 0; only the listed positive responses carry points.

**Indicator 2 (household size) uses a Household Roster:** do NOT ask household size directly. List each household member by name/nickname in a roster, apply the PPI Interview Guidance to decide who counts as a member, then derive the size band (3 or less / 4-6 / more than 6). Roster + membership rules are in the source workbook's 'Household Roster' tab and the Interview Guidance PDF (both in inputs).

## Look-up Table — PPI score → poverty likelihood (National Poverty Line)

Poverty likelihood = probability the household is below the National Poverty Line, given its PPI score. (Full multi-poverty-line lookup is in the source xlsx.)

| PPI score | Poverty likelihood (National) |
|----------:|------------------------------:|
| 0 | 0.9329 |
| 1 | 0.9270 |
| 2 | 0.9205 |
| 3 | 0.9136 |
| 4 | 0.9061 |
| 5 | 0.8981 |
| 6 | 0.8894 |
| 7 | 0.8801 |
| 8 | 0.8701 |
| 9 | 0.8594 |
| 10 | 0.8481 |
| 11 | 0.8359 |
| 12 | 0.8230 |
| 13 | 0.8093 |
| 14 | 0.7948 |
| 15 | 0.7795 |
| 16 | 0.7634 |
| 17 | 0.7466 |
| 18 | 0.7289 |
| 19 | 0.7105 |
| 20 | 0.6914 |
| 21 | 0.6715 |
| 22 | 0.6511 |
| 23 | 0.6301 |
| 24 | 0.6086 |
| 25 | 0.5866 |
| 26 | 0.5643 |
| 27 | 0.5418 |
| 28 | 0.5190 |
| 29 | 0.4962 |
| 30 | 0.4734 |
| 31 | 0.4507 |
| 32 | 0.4282 |
| 33 | 0.4060 |
| 34 | 0.3842 |
| 35 | 0.3629 |
| 36 | 0.3420 |
| 37 | 0.3218 |
| 38 | 0.3022 |
| 39 | 0.2833 |
| 40 | 0.2651 |
| 41 | 0.2477 |
| 42 | 0.2311 |
| 43 | 0.2153 |
| 44 | 0.2003 |
| 45 | 0.1861 |
| 46 | 0.1726 |
| 47 | 0.1600 |
| 48 | 0.1481 |
| 49 | 0.1369 |
| 50 | 0.1265 |
| 51 | 0.1167 |
| 52 | 0.1077 |
| 53 | 0.0992 |
| 54 | 0.0913 |
| 55 | 0.0840 |
| 56 | 0.0773 |
| 57 | 0.0710 |
| 58 | 0.0652 |
| 59 | 0.0599 |
| 60 | 0.0549 |
| 61 | 0.0504 |
| 62 | 0.0462 |
| 63 | 0.0423 |
| 64 | 0.0388 |
| 65 | 0.0355 |
| 66 | 0.0325 |
| 67 | 0.0298 |
| 68 | 0.0272 |
| 69 | 0.0249 |
| 70 | 0.0228 |
| 71 | 0.0208 |
| 72 | 0.0191 |
| 73 | 0.0174 |
| 74 | 0.0159 |
| 75 | 0.0146 |
| 76 | 0.0133 |
| 77 | 0.0122 |
| 78 | 0.0111 |
| 79 | 0.0102 |
| 80 | 0.0093 |
| 81 | 0.0085 |
| 82 | 0.0077 |
| 83 | 0.0071 |
| 84 | 0.0065 |
| 85 | 0.0059 |
| 86 | 0.0054 |
| 87 | 0.0049 |
| 88 | 0.0045 |
| 89 | 0.0041 |
| 90 | 0.0037 |
| 91 | 0.0034 |
| 92 | 0.0031 |
| 93 | 0.0028 |
| 94 | 0.0026 |
| 95 | 0.0024 |
| 96 | 0.0022 |
| 97 | 0.0020 |
| 98 | 0.0018 |
| 99 | 0.0016 |
| 100 | 0.0015 |