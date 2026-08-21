# Connect 2.63.2 Mobile Navigation Atlas

**APK:** `org.commcare.dalvik` v 2.63.2 (Connect-enabled CommCare client) — the value of `DEFAULT_APK_VERSION` in `mcp/mobile/client.ts:217`.
**Device:** `ACE_Pixel_API_34` (Pixel 6 profile, API 34, 1080x2400) for the case-list leg; `ACE_Probe_API_34` (same profile, dedicated probe AVD) for the score-gate leg — see § Provenance and coverage for which surface came from which.
**Test user:** ACE Test (ConnectID `${ACE_E2E_PHONE}` — resolves to whatever 1Password `AI-Agents/connect-test-user/phone` currently holds).
**Walk-through date:** 2026-08-14 (four ui-dumps under `docs/mobile-atlas/evidence/`, commits `9bd240c3`, `a0acb6e3`, `d529fd77`, `7a9aa71f`).
**Plus the 2026-08-01 case-list leg** — live-captured on `ACE_Pixel_API_34` with `versionName=2.63.2` device-confirmed, opp `de796bc9-3df7-42dd-be6f-4ebab68b7f42` (`spark-facilitator/20260731-0656`), commit `5e5d398a` / ace#1138 Gap 2. No ui-dump XML from that leg is checked into `evidence/`; its record is the commit message plus the selector rows it added.

## Purpose

A ground-truth navigation map of the Connect-enabled CommCare client, written by walking the app surface-by-surface and capturing UI dumps at each one. Each screen documents:

- **Resource identifier(s)** for the screen container — the most stable signal that "we're on this screen."
- **Reachable transitions** — which surfaces you can reach from here and which selector triggers each.
- **Stable selectors** — fully-qualified resource-ids + text values, with whether the element is `enabled`, `clickable`, and any conditional visibility.
- **Side effects** — system prompts, network calls, screen transitions that happen *in-place* vs. push a new activity, and mutations a gesture causes as a byproduct.

**This atlas is NARRATIVE. The selector map is IDENTITY, and it wins on conflict.** `mcp/mobile/selectors/connect-2.63.2.yaml` is the authoritative, per-row-provenanced source for *what a thing is called and how to match it*; every row there carries either `unverified: true` or a `Live-verified …` note, so the map states its own confidence. This document carries the half the map structurally cannot: **sequence and side-effects** — which screen replaces which, what fires in between, what a transition changes that you did not ask it to change. Where the two disagree, the map is right and this document is stale; **grep `connect-2.63.2.yaml` for a matcher, never paraphrase one out of here.** Recipes should reference atlas screen names and transitions, and resolve their selectors through `${SELECTOR:...}`.

## Provenance and coverage

Every surface below is one of three states. Nothing in this atlas is an untagged assertion — that is the whole point of the document, and an untagged claim here recreates the ace#972 defect one version later.

- **`calibrated-2.63.2`** — observed on a 2.63.2 device in the dated leg named in the row.
- **`carried-from-2.62.0-unverified`** — the 2.62.0 atlas's prose is reproduced by reference; it has NOT been re-walked on 2.63.2. The 2.63.0 → 2.63.2 in-place-upgrade drift check (`mcp/mobile/selectors/connect-2.63.2.yaml:7-18`) covers *selector identity* on the jobs-list / opp-detail cluster only, and says nothing about the narrative.
- **`uncovered`** — named, deliberately not guessed, routed somewhere.

| Surface | Evidence | Date | Confidence |
|---|---|---|---|
| § 1 `FormEntryActivity` chrome + question layout order | `evidence/2026-08-14-commcare-2.63.2-fieldlist-date.xml`; commit `9bd240c3` | 2026-08-14 | calibrated-2.63.2 |
| § 1 autofocus of the first field-list input | same dump (`EditText … focused="true"`); commit `9bd240c3` | 2026-08-14 | calibrated-2.63.2 |
| § 1 hint-anchored focus tap for a NON-first field-list input | ace#1299 follow-up comment — isolated live probe on the `spark-facilitator/20260813-2126` registration screen (`cbf_name` = `'PROBE-NAME'`, `phone_number` = `'0991234567'`, each in its own field), diffed against Nova's `hint` map for all 14 inputs | 2026-08-14 | calibrated-2.63.2 (issue-recorded) |
| § 1.1 inline date widget (structure + drive mechanism) | same dump; commits `9bd240c3`, `d529fd77` | 2026-08-14 | calibrated-2.63.2 |
| § 1.1 date-picker scroll-consumption side effect | commit `9bd240c3` (measured Aug 14 → Aug 22) | 2026-08-14 | calibrated-2.63.2 |
| § 1.1 bounds stability across a long tap burst; month/year rollover | — (a 20-tap burst destabilised the emulator first) | — | **uncovered** — reproduced from `connect-2.63.2.yaml:645` |
| § 2.1 "Exit Form?" choice dialog | `evidence/2026-08-14-commcare-2.63.2-exit-form-dialog.xml`; commit `a0acb6e3` | 2026-08-14 | calibrated-2.63.2 |
| § 2.2 repeat-juncture choice dialog | `evidence/2026-08-14-commcare-2.63.2-repeat-juncture.xml`; commit `a0acb6e3` | 2026-08-14 | calibrated-2.63.2 |
| § 3 score-gated finalize — FAIL branch | `evidence/2026-08-14-commcare-2.63.2-score-gate-fail-branch.xml`; commit `7a9aa71f` | 2026-08-14 | calibrated-2.63.2 (XML-recorded) |
| § 3 score-gated finalize — PASS branch | commit `7a9aa71f` message (measured on-device, no dump checked in) | 2026-08-14 | calibrated-2.63.2 (commit-recorded) |
| § 4 Deliver case selection (list → detail → CONTINUE) | commit `5e5d398a` + `connect-2.63.2.yaml:505-546`; **no dump in `evidence/`** | 2026-08-01 | calibrated-2.63.2 (commit-recorded) |
| § 4 case **SEARCH** `action_card` | — | — | **uncovered** — device-gated, routed to `skills/selector-map-heal` |
| § 5 `screen_first_start_main`, `connect_fragment_jobs_list`, opp detail pre/post-claim, Downloading Learn App, `StandardHomeActivity` (Learn + Deliver), `MenuActivity` L1-L2, Download Delivery gate | 2.62.0 atlas §§ 1-11; selector identity re-checked by `connect-2.63.2.yaml:7-18` | 2026-05-14 (narrative) / 2026-07-25 (identity) | carried-from-2.62.0-unverified |
| § Prerequisites — AVD device-clock invariant | 2.62.0 atlas § Prerequisites; `mcp/mobile/backends/avd.ts` `syncDeviceClockToHost` | 2026-05-14 | carried-from-2.62.0-unverified |
| registration/OTP, in-form camera + geopoint, Learn suite, Deliver states | — | — | carried-over at whatever confidence they already had — see the CARRY-OVER CAVEAT at `connect-2.63.2.yaml:20-25` |

## Prerequisites

### AVD device-clock invariant (load-time, ALWAYS required) — **CARRIED OVER, not re-walked on 2.63.2**

Reproduced from the 2.62.0 atlas § Prerequisites. It is a *snapshot/clock* mechanism, not an APK-version mechanism, so nothing about the 2.63.x upgrade would be expected to change it — but it has not been re-observed on 2.63.2 and is therefore tagged `carried-from-2.62.0-unverified`.

**Symptom:** opp list loads empty, toast says *"You are not authorized to make this request."* Sync retry gives the same toast. Logcat shows `401 … {"detail":"Authentication credentials were not provided."}` for `/api/opportunity/`.

**Root cause:** the AVD snapshot freezes the device wall-clock at capture time. On load N hours later the local Connect token DB still believes the token is unexpired (device clock < `expiration_date`), so the client makes the call; the server uses real time and rejects it. Large clock skew also breaks cookie HMAC / JWT `iat`-`nbf` / anti-replay windows even when the token is genuinely still valid.

**Fix — unconditional, before any Connect-side network activity:**

```bash
adb -s <serial> root
adb -s <serial> shell "date $(date +%m%d%H%M%Y.%S)"
```

Then tap `action_sync` on the jobs list to force a re-pull. Implemented as `MobileClient` → `AvdBackend.syncDeviceClockToHost` (`mcp/mobile/backends/avd.ts`), which runs as the final step of tier-1 restore and logs-rather-than-throws on failure.

**Do not derive the adb port from this snippet.** The mobile MCP's adb server port is *allocated*, not fixed — ask `mobile_diagnose` for the port and serial in use.

---

## Screen index

| Screen | Section |
|---|---|
| `FormEntryActivity` on 2.63.2 — chrome, autofocus, question layout order | [§ 1](#1-formentryactivity-on-2632) |
| Inline date widget (`DatePicker` + three `NumberPicker` columns) | [§ 1.1](#11-inline-date-widget) |
| The generic CHOICE DIALOG — two structurally different variants | [§ 2](#2-the-generic-choice-dialog) |
| "Exit Form?" — unindexed buttons, disambiguate by text | [§ 2.1](#21-exit-form) |
| Repeat juncture — indexed buttons, disambiguate by index | [§ 2.2](#22-repeat-juncture) |
| Score-gated quiz finalize — the TWO-screen finalize, both branches | [§ 3](#3-score-gated-quiz-finalize) |
| Deliver case selection — `EntitySelectActivity` → case detail → CONTINUE | [§ 4](#4-deliver-case-selection) |
| Surfaces carried over from 2.62.0 and NOT re-walked | [§ 5](#5-surfaces-carried-over-from-2620-and-not-re-walked) |
| **AVD device-clock invariant** — load-time prerequisite (carried over) | [§ Prerequisites](#prerequisites) |

---

## 1. `FormEntryActivity` on 2.63.2

`calibrated-2.63.2` — `evidence/2026-08-14-commcare-2.63.2-fieldlist-date.xml`, commit `9bd240c3` (ace#1299).

CommCare/ODK's form entry surface, dumped on 2.63.2 against a probe app whose field-list carries two text inputs and an inline date question — the shape `spark-facilitator` hit in production. Same activity for every form in every CommCare app (Learn, Deliver, anywhere), so what is calibrated here is universal.

### Container resource-ids

| Element | Resource-id (in the dump) | Notes |
|---|---|---|
| Form body pane | `form_entry_pane` | `FrameLayout`, `[0,588][1080,2337]`, wraps a `ScrollView`. |
| Question column | `odkview_layout` | `LinearLayout` inside the ScrollView; **its height is the content height, not the viewport** — `[0,588][1080,1773]` in this dump. One child `LinearLayout` per question. |
| Group label | `form_entry_group_label` inside `form_entry_header` | `[0,430][1080,588]`; text was `'Probe field-list '` (note CommCare's trailing space). Present on a question screen; **absent on the § 3 result screen.** |
| Nav pane | `nav_pane` | `[0,283][1080,430]`. |
| Previous | `nav_btn_prev` | `ImageButton`, `[21,293][142,419]`, no text. |
| Progress | `nav_prog_bar` | `ProgressBar`, `[163,293][933,419]`. |
| Next | `nav_btn_next` | `ImageButton`, `[954,293][1059,419]`, no text. |
| Toolbar | unnamed `ViewGroup` `action_bar` | Title TextView carried the *form* name (`'Bednet Visit'`); "Navigate up" `ImageButton` at `[0,136][147,283]`; "More options" at `[975,146][1080,272]`. |

Matchers for the answer widget itself: see `connect-2.63.2.yaml:595` (`form-question-input`) — **the answer `EditText` carries no resource-id at all on this build**, so it is matched by class.

### Visible content — two pure-sequence facts that live nowhere else in prose

Both were live-observed in the dump above and are the reason § 1 exists as its own section rather than a pointer at the map.

1. **CommCare AUTOFOCUSES the first input at form open.** In the dump the first question's `EditText` is `focused="true"` with **zero taps** having been issued. Its value can therefore be typed immediately — a recipe that "taps to focus" first is not just redundant, it is the failure mode below.
2. **The per-question layout order is `label TextView → optional hint TextView → EditText`.** Live in this dump: TextView `"Facilitator's full name (as on the register)"` `[42,617][1038,691]`; TextView `"First name and family name."` `[42,691][1038,756]` — *the hint*; `EditText` `focused="true"` `[42,756][1038,892]`. So **`below: <question label>` selects the HINT, and tapping a TextView is inert.** The tap reports success, focus never moves, and every subsequent `inputText` appends into whichever field was already focused. Live consequence (`9bd240c3`): `cbf_name = "Thandiwe Banda0991234567"` with `phone_number` empty and required — silent data corruption, not a visible failure.

   The idiom *appears* to work on questions **without** a hint, where the `EditText` sits directly below the label. The failure is therefore **per-question, not per-form**, which is exactly why it survived being recorded as "live-validated". See `connect-2.63.2.yaml:600` (`form-question-input-order`).

3. **The replacement idiom is hint-anchored, and it IS calibrated.** `9bd240c3` left it UNCALIBRATED rather than guess; ace#1299's own follow-up then proved it on this device and the issue closed COMPLETED on that basis. The rule is: **the focus anchor is the element immediately above the `EditText` — the field's `hint` when it has one, the question label when it does not.** Diffed against Nova's authoritative `hint` map for all 14 inputs of the `spark-facilitator/20260813-2126` Deliver forms; the isolated live probe on this screen then landed `cbf_name` = `'PROBE-NAME'` and `phone_number` = `'0991234567'` in their OWN fields. The centring scroll onto that anchor must be **unconditional** (`speed: 30`): the failure it exists for is "anchor visible, its `EditText` still below the fold", which a `when: notVisible: <anchor>` guard cannot see. Authoring form is `skills/app-test-cases/SKILL.md § Step 3` item 3. Only **index-based** anchoring remains uncalibrated.

### Transitions

| Trigger | Destination | Side effect |
|---|---|---|
| `nav_btn_next` on a non-last question | same activity, next question | — |
| `nav_btn_next` on the last question of a **plain** form | finalize → form list / `StandardHomeActivity` | Writes to the **LOCAL OUTBOX**; does NOT sync. The server round-trip is `deliver-sync.yaml`'s job — see its header and `form-submit.yaml:1-30`. |
| `nav_btn_next` on the last question of a **score-gated quiz** | the § 3 result screen — **not** a finalize | See § 3. |
| `nav_btn_prev` | previous question | On Q1 this equates to exiting the form. |
| System back / Navigate up mid-form | **the § 2.1 "Exit Form?" dialog**, not the previous screen | See § 2.1. |
| `nav_btn_next` on a required question with no answer | same activity, `warning_root` banner ("Sorry, this response is required!") | See `connect-2.63.2.yaml` `form-required-warning`. |

### Recipe-authoring guidance

- Do not author `tapOn: below: <label>` against a text question that carries a `hint` — the anchor resolves to the hint TextView and the tap is inert (ace#1299). Anchor on the **hint** there, and on the label only when the question has no hint.
- Do not tap to focus the first field-list input; it is already focused.
- Every LATER input on the same field-list needs the focus sequence: **unconditional** centring `scrollUntilVisible` at `speed: 30` onto that anchor, then `tapOn: below: <anchor>`, then `inputText`, then `hideKeyboard` (ace#1299, proven live on this build).
- Assert `warning_root` is **not** visible after answering, before advancing — that is the cheap structural proof the answer registered.
- Resolve every id through `${SELECTOR:...}`; the raw ids above are for reading dumps, not for authoring.

### Open questions for this screen

- **Index-based** anchoring into a multi-question field-list is still uncalibrated. The hint-anchored idiom is not — it was proven live in ace#1299 after `9bd240c3` declined to guess it; see § 1 fact 3.
- `select_one` / `select_multi` / integer widgets were not in this dump; their shapes are `carried-from-2.62.0-unverified` (2.62.0 atlas § 7, § 12).

---

### 1.1. Inline date widget

`calibrated-2.63.2` — same dump; commits `9bd240c3` (the hazard) and `d529fd77` (the drive mechanism). Selector rows: `connect-2.63.2.yaml:630-650`.

A CommCare `kind: date` question renders a **native Android `DatePicker`, inline in the form**, not a modal. It has no resource-id; match it by class.

### Container resource-ids

- `DatePicker` (class match) — bounds **`[214,1208][865,1765]`** on a 1080x2400 portrait viewport, inside the field-list group.
- `android:id/pickers` — the `LinearLayout` holding the three columns; shares the DatePicker's bounds. Useful as a presence check for "this screen carries an inline date question."
- Three `NumberPicker` columns, in **display order month / day / year**, each `scrollable="true"`:
  `[235,1250][403,1723]` (month), `[445,1250][613,1723]` (day), `[655,1250][823,1723]` (year).

### Visible content

Each column renders exactly three children, in this order:

| Child | Class | Holds | Day-column bounds |
|---|---|---|---|
| previous value | `Button` | e.g. `"13"` | `[445,1250][613,1423]` |
| **current value** | `EditText`, id `android:id/numberpicker_input` | e.g. `"14"` | `[445,1423][613,1549]` |
| next value | `Button` | e.g. `"15"` | `[445,1549][613,1723]` |

In the dump the three columns read `Jul / Aug / Sep`, `13 / 14 / 15`, `2025 / 2026 / 2027` — i.e. the widget defaults to today.

### Transitions — and the side effect that matters

**A swipe ORIGINATING INSIDE the picker's bounds is CONSUMED by the picker and SPINS THE DATE.** Each column is `scrollable=true`, so a centre-origin swipe — exactly what `scrollUntilVisible` issues — never reaches the page. Measured in `9bd240c3`:

| Gesture | Origin | Date | Page |
|---|---|---|---|
| portrait swipe | x=540 (centre) | Aug 14 → **Aug 22** | did NOT move |
| landscape swipe | x=1200 (centre) | Aug 22 → **Aug 25** | did NOT move |
| landscape swipe | x=300 (edge) | Aug 25 → Aug 25 | (no mutation) |

Both halves bite at once: questions below the picker are unreachable (the group label stayed at `[0,430][1080,588]` across the centre swipe), **and** a payment-gating field is silently changed with nothing asserting against it.

**Page scroll must therefore originate outside the picker's x-range.** Use `lib/fieldlist-gestures.ts` → `safeScrollOriginX(picker, viewport)`. It throws rather than returning a plausible number when the picker spans the full viewport width — silently returning one would put us straight back to spinning the date.

**The calibrated DRIVE mechanism is a tap, not a swipe.** Tapping the **lower** `Button` of a column increments that column by **exactly one** — measured with read-back across two separate taps, day Aug 14 → 15 → 16 (`d529fd77`). Then **read the result back from `numberpicker_input`; do not assume the tap landed.** A swipe inside a column also moves the value, but by an unpredictable number of steps (one centre swipe jumped Aug 14 → 22), so it is the hazard above, not a drive mechanism.

This makes the motivating constraint — `validate: . > today() and . <= date(today() + 30)` — walkable with a **single** tap: the default (today) fails `. > today()`; one tap on the day column's next-value Button satisfies both clauses.

### Recipe-authoring guidance

- Never issue an unscoped `scrollUntilVisible` on a screen that carries an inline date question. Compute the origin via `safeScrollOriginX`.
- Drive by tapping the next-value `Button`; assert via `numberpicker_input`.
- One tap covers the common strictly-future case; do not build a loop you have not calibrated (see the residuals below).

### Open questions for this screen

Reproduced verbatim in substance from `connect-2.63.2.yaml:645`, **not** resolved here:

- **Bounds stability across a long tap sequence — UNVERIFIED.** A 20-tap burst destabilised the emulator before it could be measured.
- **Month/year rollover at a boundary — UNVERIFIED.** Same cause.

Neither is on the critical path, because the common `. > today()` case needs one tap. Both stay open; do not launder them by omission.

---

## 2. The generic CHOICE DIALOG

`calibrated-2.63.2` — `evidence/2026-08-14-commcare-2.63.2-exit-form-dialog.xml` and `…-repeat-juncture.xml`, commit `a0acb6e3` (ace#1007, ace#1290).

Two surfaces ACE had zero coverage for turn out to be **the same CommCare component** — and the two dumps prove they are **structurally different where it counts**. Both render the same wrapper chain (`action_bar_root` › `android:id/content` › `parentPanel` › `customPanel` › `custom`) and both carry `choice_dialog_title` › `dialog_title_text`. The buttons are addressed **differently**.

### The branch rule — this atlas's own contribution

**Read `dialog_title_text` FIRST to decide which dialog you are on, because the button ids differ between them.** `connect-2.63.2.yaml:605` (`form-choice-dialog-title`) is the anchor to branch on. A recipe that reaches for a button id before reading the title is correct on exactly one of these two surfaces and silently wrong on the other.

| | § 2.1 "Exit Form?" | § 2.2 Repeat juncture |
|---|---|---|
| `dialog_title_text` | `"Exit Form?"` | `"Add a new <repeat label>?"` |
| Button ids | **one** id, `choice_dialog_panel`, shared by both buttons | **three** indexed ids, `choice_dialog_panel_1/_2/_3` |
| Button container | `choices_list_view` (`ListView`) | unnamed `LinearLayout` |
| Disambiguate by | **TEXT** (CommCare chrome, app-independent) | **INDEX** (the label interpolates app content) |

---

### 2.1. "Exit Form?"

`calibrated-2.63.2` — `evidence/2026-08-14-commcare-2.63.2-exit-form-dialog.xml`.

### Container resource-ids

- `choice_dialog_title` (`LinearLayout`, `[133,1036][405,1114]`) › `dialog_title_text` (`TextView`, text **`"Exit Form?"`**).
- `choices_list_view` (`ListView`, `[133,1167][947,1458]`) holding the two buttons.
- Dialog root frame at `[28,931][1052,1542]`; panel at `[70,973][1010,1500]`.

### Visible content

| Button | Resource-id | Text | Bounds |
|---|---|---|---|
| Stay | `choice_dialog_panel` | `"STAY IN FORM"` | `[133,1167][947,1312]` |
| Exit | `choice_dialog_panel` | `"EXIT WITHOUT SAVING"` | `[133,1315][947,1458]` |

**Two buttons, ONE UNINDEXED id.** They are stacked vertically and can only be told apart by text. That is fine here: the text is CommCare *chrome*, not app content, so it is stable across every ACE-built app. See `connect-2.63.2.yaml:610` (`form-exit-dialog-button`).

### Transitions

| Trigger | Destination | Side effect |
|---|---|---|
| **Arriving here:** back-press / Navigate-up from inside a form **that did not finalize** | this dialog — *not* the previous screen | This is what a back-press lands on. It is where the Deliver smoke died on `spark-facilitator/20260813-2126`. |
| Tap `"STAY IN FORM"` | dismiss; stay on the current question | — |
| Tap `"EXIT WITHOUT SAVING"` | pop to the `MenuActivity` form list | **Answers are discarded.** |

### Recipe-authoring guidance

**A form-submit that leaves the device on "Exit Form?" has NOT submitted — whatever its `POST_SUBMIT` screenshot shows.** That is the ace#1290 consequence stated where an author will read it. Assert the dialog is *absent* after a finalize rather than trusting the screenshot.

### Open questions for this screen

- Whether a back-press from a form with **no** pending input skips the dialog entirely was not exercised on 2.63.2. The dump is of the dialog, not of the decision that produced it.

---

### 2.2. Repeat juncture

`calibrated-2.63.2` — `evidence/2026-08-14-commcare-2.63.2-repeat-juncture.xml`.

A `kind: repeat` field brackets each repetition with an entry prompt and an "add another?" exit prompt. Before `a0acb6e3` neither had a selector row, an atlas section, or a palette recipe anywhere in ACE — so `app-test-cases` could not author a roster leg at all (it MARKED the region rather than walking it, since authoring blind is barred by its own Step 3.4 gate), and the Deliver leg then hard-failed there on-device.

### Container resource-ids

- `choice_dialog_title` (`LinearLayout`, `[133,1006][537,1084]`) › `dialog_title_text` (`TextView`) — text in the dump: **`"Add a new null?"`**.
- Buttons live in an **unnamed** `LinearLayout` at `[133,1137][947,1467]` — note this is *not* `choices_list_view`, unlike § 2.1.
- Dialog root frame at `[28,901][1052,1572]`.

### Visible content

| Button | Resource-id | Text in the dump | Bounds (1080x2400) |
|---|---|---|---|
| Back | `choice_dialog_panel_1` | `"GO BACK"` | `[133,1137][374,1357]` |
| **Add** | `choice_dialog_panel_2` | `"ADD A NEW NULL?"` | `[419,1137][660,1467]` |
| Skip | `choice_dialog_panel_3` | `"DO NOT ADD"` | `[705,1137][947,1412]` |

**`_2` interpolates the repeat's OWN name.** The dump literally reads `ADD A NEW NULL?` because the probe form's repeat had no label. So a text matcher on `_2` is app-specific and brittle, while the **index is stable — prefer the index.** Rows: `connect-2.63.2.yaml:615` (`form-repeat-juncture-button`, `_2`), `:620` (`form-repeat-juncture-skip`, `_3`), `:625` (`form-repeat-juncture-back`, `_1`).

### Transitions

| Trigger | Destination | Side effect |
|---|---|---|
| Tap `_3` `"DO NOT ADD"` | **advances past the repeat**, to the next question after it | Verified live by landing on the following `select1`. This is what a smoke walk usually wants. |
| Tap `_2` (the ADD action) | enters another repetition | — |
| Tap `_1` `"GO BACK"` | **returns to the previous question**, rather than entering the repeat | — |

### Recipe-authoring guidance

- Branch on `dialog_title_text` first (§ 2); then address by index, never by `_2`'s label.
- A smoke walk crossing a roster wants `_3`.

### Open questions for this screen

- The **entry** prompt (the one that fires *before* the first repetition) was not separately dumped; only the "add another?" juncture is in `evidence/`. Whether it is the same component with a different title is likely but **not observed**.
- Whether `_1`/`_2`/`_3` are stable when the repeat *does* carry a label (i.e. whether the title/label interpolation ever changes the id set) was not exercised.

---

## 3. Score-gated quiz finalize

`calibrated-2.63.2` — FAIL branch from `evidence/2026-08-14-commcare-2.63.2-score-gate-fail-branch.xml`; PASS branch **commit-recorded** in `7a9aa71f` (ace#1302, confirms ace#569). Run on `ACE_Probe_API_34` against a purpose-built single-question score-gated quiz with trailing relevance-gated result labels.

**A score-gated quiz does NOT auto-finalize on `nav_btn_next`.** The finalize is **TWO screens**: answering the last question advances to a *result-label screen*, whose FINISH button is what actually submits + syncs. Contrast with plain content forms (Learn **and** Deliver), which auto-finalize on the last question's `nav_btn_next` into the local outbox — see `form-submit.yaml:1-30` and the `deliver-sync.yaml` header it points at.

### Container resource-ids — screen 2 (the result screen)

| Element | Resource-id | Notes |
|---|---|---|
| Finish button | `nav_btn_finish` | `FrameLayout`, **`[126,293][1059,419]`**, `clickable=true`. Sits *inside* `nav_pane`. |
| Finish label | `nav_btn_finish_text` | `TextView`, text `"FINISH"`, `[126,293][959,419]`. |
| Finish icon | `nav_image_finish` | `ImageView`, `[959,293][1059,419]`. |
| Previous | `nav_btn_prev` | `[21,293][126,419]` — narrower than on § 1 (`[21,293][142,419]`), because FINISH claims the width. |
| Next | `nav_btn_next` | **still present**, `[954,293][1059,419]` — *overlapped by* `nav_btn_finish`'s bounds. Presence of `nav_btn_next` is therefore **not** evidence you are on a question screen. |
| Result label | unnamed `TextView` inside `text_container` › `text` | The relevance-gated result prose. |

**Structural tell for "this is the result screen":** `form_entry_header` / `form_entry_group_label` are **absent** from this dump — `form_entry_pane` starts at y=430 with no group label above it. On § 1's question screen the group label occupies `[0,430][1080,588]`. Row: `connect-2.63.2.yaml:432`-`:435` (`form-nav-finish`).

### Visible content — BOTH branches

| Branch | Provenance | `user_score` | Result label | Nav |
|---|---|---|---|---|
| Correct answer | **commit-recorded** (`7a9aa71f`) | `100` | `"PASSED. You scored 100 percent."` | FINISH |
| Wrong answer | **XML-recorded** (`…-score-gate-fail-branch.xml`) | `0` | `"NOT PASSED. Go back to module 1 and read it again."` | FINISH |

The checked-in dump is the **FAIL** branch: `TextView` text `"NOT PASSED. Go back to module 1 and read it again."` at `[42,459][1038,597]`, with `nav_btn_finish_text = "FINISH"`. The PASS branch was measured in the same session but its dump is not in `evidence/`; the commit message is its record.

### Transitions

| Trigger | Destination | Side effect |
|---|---|---|
| `nav_btn_next` on the last quiz question | **the result screen** (this surface) | Does **not** finalize. |
| Tap `nav_btn_finish` on the result screen | `"Form successfully completed"` → `StandardHomeActivity` → `"1 form sent to server!"` | Submits **and** syncs. Without this press the assessment never submits and **Connect never unlocks Deliver** (ace#569). |

### Recipe-authoring guidance

- `form-submit.yaml` already encodes this: try `form-submit` → else `nav_btn_next` → **then, if FINISH is visible, tap it.** Do not re-derive it; cite `form-submit.yaml:1-30`.
- **ace#569's two-screen rule needs NO qualifier.** ace#1302 suggested it might hold only for *multi*-question quizzes; it held on a **single**-question score-gated quiz. So a walk reporting "`nav_btn_finish` not visible" **has not reached the result screen** — that is the thing to investigate, not the rule.
- **A missing result screen is an APP-SHAPE defect, not platform behaviour.** The platform renders trailing relevance-gated labels on *both* branches. A walk that never sees one should be investigated app-side (label reachability in form order; whether `user_score` is computed before the labels are evaluated; whether the `relevant` expressions are exhaustive). It must **not** be recorded as a CommCare limitation.
- Related consequence: `spark-facilitator/20260813-2126` reported a score-gated assessment auto-finalizing with no on-screen score, i.e. a CBF completing a **payment gate** blind. That report observed the PASS path only and could not re-test the fail branch, because **Learn completion is one-way per `(test user, opportunity)`** — see `docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md` and the ace#569 gotcha in `CLAUDE.md § Gotchas`. `7a9aa71f` settled it on a probe app instead of consuming a run.

### Open questions for this screen

- The PASS branch has no checked-in ui-dump. Its selectors are asserted to be identical to the FAIL branch's (same `nav_btn_finish` cluster) on the strength of `7a9aa71f`'s on-device observation; that identity is **inferred from the commit, not diffed between two dumps.**
- Whether a multi-*screen* (as opposed to multi-question) quiz inserts anything between the last answer and the result screen was not exercised.

---

## 4. Deliver case selection

`calibrated-2.63.2` — **commit-recorded, no dump in `evidence/`.** Live-captured 2026-08-01 on `ACE_Pixel_API_34` with `versionName=2.63.2` device-confirmed; Deliver app `d571d16dc311492e9abc453196824c39`, opp `de796bc9-3df7-42dd-be6f-4ebab68b7f42` (`spark-facilitator/20260731-0656`), module "Community Meeting Record" → form "Village Monitoring Record" (followup on case type `cbf`), one registered case "Thandiwe Banda" / "Kanyika". Commit `5e5d398a`, ace#1138 Gap 2. Selector rows: `connect-2.63.2.yaml:505-546`.

A `followup` form renders CommCare's `EntitySelectActivity` **between** the module row and the form's first question. **CommCare collects the CASE BEFORE THE FORM.**

### Container resource-ids

| Element | Resource-id | Notes |
|---|---|---|
| Case list | `screen_entity_select_list` | `ListView`, bounds `[0,705][1080,1367]`; one clickable `LinearLayout` per case, **plus a trailing `action_card` ("SEARCH") inside the same container.** `connect-2.63.2.yaml:526`. |
| Column-header strip | `entity_select_header` | Bounds `[0,283][1080,705]`. A **SIBLING** of the list container, not a child — which is what makes `childOf: <container>` a sound exclusion. |
| Per-cell text | `entity_view_text` | Present in **both** the header strip and every data row. The cell is **not** clickable; the clickable node is the row `LinearLayout` two levels up. |
| Case DETAIL screen | `entity_detail` › `screen_entity_detail_list` | One `detail_type_text` / `detail_value_text` pair per configured column. `connect-2.63.2.yaml:536`. |
| DETAIL CONTINUE | `entity_select_button` | `Button`, text `"CONTINUE"`, bounds `[0,283][1080,409]` — **full-width, pinned directly under the toolbar**, not at the bottom of the screen where a confirm button is usually looked for. |

### Visible content

The header strip on the captured app held four cells: `Name / Dzina / Zina`, `Village / Mudzi / Muzi`, `Last meeting / Womaliza / Wakumaliza`, `Next meeting / Wotsatira / Wakulondezga`. Empty-valued cells **are present in the tree** (a case with no `date_of_meeting` yet renders an empty cell), so cell *presence* says nothing about the value.

### Transitions — the interposed screen

**A row tap does NOT open the form.** It opens a per-case DETAIL screen, whose CONTINUE is what proceeds. The live-observed order is:

```
module row → CASE LIST → case detail → CONTINUE → FORM LIST → form
```

Note the tail: after CONTINUE the device sits on the module's one-row form-list `MenuActivity`, **not** on the first question. This is why the case handoff has to sit **between Level 1 and Level 2** of `deliver-form-walk.yaml` — placed after them, the walk selects the case and then stalls on an untapped form list. See `deliver-case-select.yaml:15`, `:65`, `:107` for the recipe's own record of all three facts, and `deliver-sync.yaml:75` for the consequence downstream (a case-bound form sits one level deeper, so the return path needs **four** backs, not two — ace#1494).

The detail screen appears when the module declares a case-list `details` block, **which every ACE-built Deliver module does**, because Nova emits `details` alongside `results`. `deliver-case-select.yaml` therefore taps CONTINUE under a `when: visible` guard rather than unconditionally, so a module without a `details` block still passes.

### Recipe-authoring guidance

- **Scope every row match to `case-list-container`**, and match the row **by case name, never positionally.** Two independent ways exist to miss the row: the header strip reuses the data-row cell id, and the toolbar carries the module name (the ace#590 anti-toolbar class). Scoping alone is *still* not enough for a positional tap — the trailing SEARCH `action_card` is inside the container.
- Use `childOf` (descendant-of), not the menu recipes' geometric `below:` — the header is a *sibling* of the container, so descendant-scoping excludes it structurally.
- **No positional fallback, deliberately.** A wrong-case tap is silent, and for a payable deliver unit it means a payment keyed to the wrong `entity_id`.

### Open questions for this screen

- **Case SEARCH is `uncovered`** — see § Open questions across the atlas. It is the trailing `action_card` in this container, and it has zero selector rows.
- No ui-dump XML from the 2026-08-01 leg is checked into `evidence/`; the record is the commit plus the selector rows' inline provenance. A future leg should check the dump in so this section can be diffed like §§ 1-3.

---

## 5. Surfaces carried over from 2.62.0 and NOT re-walked

`carried-from-2.62.0-unverified`. These are **not re-transcribed here** — read them in the 2.62.0 atlas and treat this table as the pointer plus the currency statement. This document deliberately does not restate their selectors, because restating them would launder 2.62.0 prose into a 2.63.2 heading.

| Surface | Read it at | Currency on 2.63.2 |
|---|---|---|
| `screen_first_start_main` (Welcome + nav drawer) | 2.62.0 atlas § 1 | narrative unverified |
| `connect_fragment_jobs_list` (Opportunities list) | 2.62.0 atlas § 2 | **selector identity re-checked** (see below); narrative unverified |
| Opportunity detail — pre-claim | 2.62.0 atlas § 3 | **selector identity re-checked**; narrative unverified |
| Downloading Learn App (`Step N of 14`) | 2.62.0 atlas § 4 | narrative unverified |
| `StandardHomeActivity` — Learn mode | 2.62.0 atlas § 5 | narrative unverified |
| `MenuActivity` — suite + form list, levels 1-2 | 2.62.0 atlas § 6 | narrative unverified |
| Opportunity detail — post-Learn-complete (certificate) | 2.62.0 atlas § 8 | narrative unverified |
| Opportunity detail — post-Deliver-download (View Info bottom-sheet) | 2.62.0 atlas § 8.5 | **selector identity re-checked**; narrative unverified |
| Download Delivery gate | 2.62.0 atlas § 9 | narrative unverified |
| `StandardHomeActivity` — Deliver mode | 2.62.0 atlas § 10 | narrative unverified |
| `MenuActivity` — Deliver-side | 2.62.0 atlas § 11 | narrative unverified |

**What the 2.63.0 → 2.63.2 drift check actually established** (`mcp/mobile/selectors/connect-2.63.2.yaml:7-18`): after an in-place `adb install -r` upgrade 2.63.0 → 2.63.2 with app data preserved, on `ACE_Pixel_API_34`, **NO selector drift was observed** on the jobs-list / opp-detail cluster — `connect_fragment_jobs_list`, `rvJobList`, `tv_section_header`, `rootCardView`, `llOpportunity`, `imgJobType`, `tvTitle`, `tvDate`, `tv_progress_percent`, `progressBar`, `btn_resume`, `btn_view_info`, `action_sync`, `action_bell` all present with 5 tiles rendered; the `connect_delivery_*` bottom-sheet cluster rendering; PersonalID unlock + post-login landing unchanged; zero FATAL EXCEPTIONs across launch, sync and navigation. That is a statement about **identity**, on **those** surfaces. It is not a statement about the narrative, and it does not extend past the surfaces it names.

**And the CARRY-OVER CAVEAT stands, reproduced not resolved** (`connect-2.63.2.yaml:20-25`): rows that were already `unverified: true` (or lacked a `Live-verified` note) under 2.63.0 remain **exactly** as unverified — the 2.63.2 baseline inherits 2.63.0's partial-calibration status and **does not launder it**. The surfaces NOT walked in that sweep — **registration/OTP, in-form camera + geopoint, Learn suite, and the Deliver states** — keep whatever confidence they carried before. Finish via `/ace:step selector-map-calibrate`.

Two corrections from the 2.62.0 era that are load-bearing and easy to re-import by accident, so they are named here rather than left to be re-read out of stale prose:

- **`viewJobCard` is NOT a Learn-vs-Deliver differentiator.** The 2.62.0 atlas § 10 claims it is present in Deliver and absent in Learn; that is FALSE on 2.63.x — the Learn home renders it too once the opp is claimed (ace#893). The validated Deliver-only anchor is `deliver-home-daily-visits` (`connect-2.63.2.yaml:490`), and *that* row carries its own caveats (text anchor, English locale, depends on the opp declaring a daily max).
- **Menu containers are display-mode-dependent.** `screen_suite_menu_list` (list) and `grid_menu_grid` (grid) render the same rows; the anchor must accept either (ace#1127). Never narrow a menu wait back to one container.

---

## Open questions across the atlas

1. **Case SEARCH — `uncovered`, device-gated, routed to `skills/selector-map-heal`. DO NOT GUESS IT.**
   The case list's trailing `action_card` ("SEARCH") is referenced in *comment prose only*. It has **zero selector rows**, and **none of the four 2026-08-14 evidence dumps is a case-list dump** — the case-list leg (§ 4) predates them and left no XML. Verified while writing this section:

   ```
   $ grep -n "SEARCH\|action_card\|entity_select_search" mcp/mobile/selectors/connect-2.63.2.yaml
   526:    purpose: "The case-list ListView … plus a trailing `action_card` (\"SEARCH\") …"
   $ ls docs/mobile-atlas/evidence/
   2026-08-14-commcare-2.63.2-exit-form-dialog.xml
   2026-08-14-commcare-2.63.2-fieldlist-date.xml
   2026-08-14-commcare-2.63.2-repeat-juncture.xml
   2026-08-14-commcare-2.63.2-score-gate-fail-branch.xml
   ```

   One comment reference, one file, zero rows; no case-list XML anywhere. So the SEARCH surface's container id, its input field, its result-list shape, and whether selecting a result re-enters the § 4 detail screen or goes straight to the form are **all unknown**. This is exactly the class `skills/selector-map-heal` exists for: it repairs the map from a live failure dump, proposes rows, and ships them only after re-running the blocked leg on-device. Route it there; a guessed row here would recreate the 2.63.0 selector-drift class.

2. **Date-picker residuals — UNVERIFIED**, reproduced from `connect-2.63.2.yaml:645` and § 1.1: **bounds stability across a long tap sequence**, and **month/year rollover at a boundary**. A 20-tap burst destabilised the emulator before either could be measured. Not on the critical path (the common `. > today()` case is one tap), but not resolved.

3. **Everything still flagged `unverified: true` in the map, plus the CARRY-OVER CAVEAT set.** Per `connect-2.63.2.yaml:20-25` and `:548-590`: `opp-detail-start-delivering`, `form-submit` (whose absence is *expected*, not a gap — see its row), `assessment-result-passed`, `assessment-result-failed`, `deliver-start-button`, and the registration/OTP + in-form camera/geopoint + Learn-suite + Deliver-state surfaces. This atlas neither promotes nor demotes any of them. `/ace:step selector-map-calibrate` is the systematic walk that closes them.

4. **§ 1's INDEX-based idiom for reaching a non-first input in a field-list is uncalibrated.** `9bd240c3` refused to guess it and so does this document. The hint-anchored idiom is calibrated — ace#1299 proved it live after `9bd240c3` shipped; see § 1 fact 3.

5. **§ 2.2's repeat ENTRY prompt was never dumped** — only the "add another?" juncture. Likely the same component; not observed.

6. **§ 3's PASS branch has no checked-in dump.** Its selector identity with the FAIL branch is inferred from `7a9aa71f`'s on-device observation, not diffed between two dumps.

7. **§ 4 has no checked-in dump either.** A future Deliver leg should check the `EntitySelectActivity` XML into `evidence/` so § 4 can be diffed like §§ 1-3.

8. **The § 5 surfaces have never been narratively re-walked on 2.63.2** — only their selector identity was drift-checked, and only on the jobs-list / opp-detail cluster. A full 2.63.2 walk is what would convert that whole table from `carried-from-2.62.0-unverified` to `calibrated-2.63.2`.
