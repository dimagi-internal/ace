# CCHQ data-forwarding to Connect uses `ConnectFormRepeater`, not generic `FormRepeater`

**Status:** Learning captured; doctor probe updated; setup automation TBD.

**Origin:** Setting up `connect-ace-prod` for the turmeric run 20260511-2053 Phase 5 unblock. The "Run Your First Connect Opportunity" Confluence doc (GDrive `18Y1UQJW1aIwcgSt-Mt1Vze5pdQPAPs0I`) says to set up data forwarding under **"Forward Forms"** with `Include 'app_id' URL query parameter: ✅`. That label matches the **generic** `FormRepeater` section in CCHQ's `/motech/forwarding/` page — which I configured. Result: every form submission Connect tried to receive got `400 {"app_id":["This field may not be null."]}` because the generic FormRepeater sends a raw-form payload shape Connect's `XFormSerializer` (`commcare_connect/form_receiver/serializers.py:44`) doesn't accept.

The doc is outdated. The right type is **`ConnectFormRepeater`**, which renders under a section named **"Forward Form Metadata to Commcare Connect"** on the same data-forwarding page. The section is feature-flag-gated, so it only appears once `COMMCARE_CONNECT` is enabled on the project.

## Code evidence (commcare-hq `corehq/motech/repeaters/models.py`)

```python
class ConnectFormRepeater(FormRepeater):
    """
    A repeater that only forwards form metadata and commcare connect question blocks
    """
    class Meta:
        proxy = True

    friendly_name = _("Forward Form Metadata to Commcare Connect")
    payload_generator_classes = (ConnectFormRepeaterPayloadGenerator,)

    def form_class_name(self):
        return 'ConnectFormRepeater'

    @classmethod
    def available_for_domain(cls, domain):
        return toggles.COMMCARE_CONNECT.enabled(domain)
```

Three things that matter:

1. **Different payload generator** — `ConnectFormRepeaterPayloadGenerator` only sends form metadata + Connect question blocks; generic `FormRepeater` sends the raw form payload. Connect's receiver only accepts the Connect-shaped payload.
2. **Different URL path for the create form** — `/motech/forwarding/new/ConnectFormRepeater/` vs `/motech/forwarding/new/FormRepeater/`. The Connect one has 6 visible fields (no Payload Format); the generic one has 7 (Payload Format is XML/JSON).
3. **Feature-flag-gated** — without `COMMCARE_CONNECT` enabled, the section is invisible in the UI and the URL 404s. That's why the section was empty until the flag flipped on 2026-05-12.

## Live reproduction (2026-05-13 against `connect-ace-prod`)

Before fix:
- Two rules under "Forward Forms" (generic FormRepeater) → CCHQ fired forwarders → `?app_id=None` in URL, `app_id: null` in body → Connect's `XFormSerializer.app_id` (`required=True`) rejected → 400.

After fix:
- One rule under "Forward Form Metadata to Commcare Connect" (`ConnectFormRepeater`) → CCHQ uses the Connect-shaped payload generator → Connect's receiver accepts (or 400s for legitimately bad data, but at least the type contract is right).

## The setup doc's wording is wrong

> Settings → Project Settings → Data Forwarding (left menu) → Forward Forms

The doc was written when "Forward Forms" was the only choice — likely before the dedicated `ConnectFormRepeater` was added. The right section name today is **"Forward Form Metadata to Commcare Connect"**. Worth a PR to the Confluence doc once the team confirms.

## ACE-side mitigation

- **`bin/ace-doctor` `cchq_connect_features` probe** now checks three things instead of two:
  1. `COMMCARE_CONNECT` feature flag enabled
  2. Active OAuth Connection to `connect.dimagi.com/api/receiver/`
  3. **Active `ConnectFormRepeater` rule under "Forward Form Metadata to Commcare Connect"** (NOT a rule under generic "Forward Forms" — those send the wrong payload shape)
- Per-state WARN messages now explicitly call out the section-name distinction and warn that a rule under generic "Forward Forms" will NOT work.
- The probe URL is `/motech/forwarding/new/ConnectFormRepeater/` (also gated by the feature flag), so a 404 there cleanly indicates the flag isn't enabled.

## Open follow-up (not done in this commit)

- **`/ace:cchq-connect-setup <hq-domain>` skill** — automate the 3-step CCHQ-side setup the same way ACE automates everything else. Would consume the OAuth client creds from 1Password (`Connect Delivery / Tech` vault → `Production HQ Data Forwarding Credentials for CCC`), drive the `/motech/conn/add/` + `/motech/forwarding/new/ConnectFormRepeater/` Django forms via cookies+CSRF, and verify with the doctor probe. One-shot per HQ project space, same shape as `/ace:mobile-bootstrap` or `/ace:ocs-bootstrap-template`. Scripts at `/tmp/cchq-connect-setup.py` and `/tmp/cchq-fix-repeater.py` show the working flow that can be wrapped into a skill.

## Files touched

- `bin/ace-doctor` — `cchq_connect_features` probe updated to check for `ConnectFormRepeater` specifically, point at the right section name, and warn explicitly about the FormRepeater vs ConnectFormRepeater confusion
- `docs/learnings/2026-05-13-cchq-connect-data-forwarding-uses-ConnectFormRepeater.md` — this file
