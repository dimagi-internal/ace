// The Phase 6 training scripts must authenticate as ace@ through the canopy-minted
// Google token (lib/ace-google-auth.ts), not through a service-account key file.
// ace#3310 removed the key from every machine; ace#3334 recorded these five scripts
// still looking for it, so every Phase 6 illustrated guide, deck bind and deck render
// check died with "No Google service-account key found" before doing any work.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPTS = [
  'embed-doc-screenshots.ts',
  'bind-deck-frames.ts',
  'deck-visual-capture.ts',
  'check-stencil-token-drift.ts',
  'rerender-training-deck-in-place.ts',
];

describe('Phase 6 training scripts authenticate through AceGoogleAuth', () => {
  for (const name of SCRIPTS) {
    it(name, () => {
      const src = readFileSync(resolve(__dirname, '../../scripts', name), 'utf8');
      expect(src).toContain('AceGoogleAuth');
      expect(src).not.toMatch(/google\.auth\.GoogleAuth\s*\(/);
      expect(src).not.toMatch(/gws-sa-key/);
    });
  }
});
