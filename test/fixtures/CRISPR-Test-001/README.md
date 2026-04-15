# CRISPR-Test-001 — Synthetic Test Fixture

Permanent synthetic opportunity for regression testing ACE skills. Use this fixture to test skill changes before running on real opportunities.

## Purpose

- **Regression testing:** After editing any SKILL.md, run it against this fixture to verify it still works
- **New skill development:** Test new skills against structurally valid data
- **Dry-run validation:** Test `--dry-run` mode end-to-end

## Contents

- `pdd.md` — Complete PDD for a fictional CHW training pilot
- `state.yaml` — Initial state with all steps pending
- `app-summaries/` — Minimal but structurally valid Learn and Deliver app summaries
- `connect-setup/invites.md` — Fake LLO contacts (team members as stand-ins)

## Usage

### Option 1: Run via /ace:step
```
/ace:step <skill-name> CRISPR-Test-001 --dry-run
```

### Option 2: Push to GDrive first
Copy these files to `ACE/CRISPR-Test-001/` in the shared Google Drive, then run skills against them as you would a real opportunity.

### Option 3: Full lifecycle test
```
/ace:run CRISPR-Test-001 --mode review --dry-run
```

## Fake Contacts

The LLO contacts in this fixture are ACE team members. Do NOT send real emails to them during testing — always use `--dry-run` mode.
