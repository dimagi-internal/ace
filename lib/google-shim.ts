/**
 * Drop-in shim that preserves the `import { google } from 'googleapis'`
 * call shape while pulling from the per-API subpackages instead of the
 * 194 MB `googleapis` meta-package. Cuts node_modules from 332 MB to
 * 141 MB on every `/ace:update`. See issue #129 for the analysis.
 *
 * Existing call sites (16 of them across `mcp/` + `scripts/`) keep using
 * `google.drive({ version: 'v3', auth })`, `new google.auth.GoogleAuth(…)`,
 * etc. — only the import path changes per file. Same wire protocol, same
 * generated types, just scoped to the APIs ACE actually uses (Drive,
 * Docs, Sheets, Slides, Forms) plus the auth client.
 */
import { drive } from '@googleapis/drive';
import { docs } from '@googleapis/docs';
import { sheets } from '@googleapis/sheets';
import { slides } from '@googleapis/slides';
import { forms } from '@googleapis/forms';
import * as auth from 'google-auth-library';

export const google = { drive, docs, sheets, slides, forms, auth };
