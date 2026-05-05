/**
 * Build a real training deck from the Turmeric fixture.
 *
 * Validates the training-deck-build pipeline end-to-end against
 * realistic opp content (not synthetic smoke text). Reads the fixture's
 * pdd.md + app-summaries to draft a plausible deck-outline.md, then
 * runs the same parse → copy template → batchUpdate pipeline the
 * `training-deck-build` skill uses.
 *
 * Output: a real Slides deck in the Drive root, named with the
 * timestamp so it doesn't collide with smoke-test runs.
 *
 * Idempotent — every run creates a new deck. Safe to delete the deck
 * after inspection.
 */
import { google } from 'googleapis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseDeckOutline,
  buildSlidesRequests,
  buildSpeakerNotesRequests,
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
} from '../lib/training-deck-spec.js';

const KEY_FILE = `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;
const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../test/fixtures/CRISPR-Test-003-Turmeric',
);

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// Hand-curated deck outline derived from the Turmeric fixture's existing
// flw-training-guide.md. In production, training-deck-outline (the skill)
// would generate this from pdd + app-summaries; we simulate that step
// here with a real-content outline that exercises every parser feature.
const TURMERIC_DECK_OUTLINE = `# Turmeric Market Survey — FLW Training

A 5-minute walkthrough for new field workers.

---

## Slide: What you'll be doing

For each turmeric vendor you meet, you will photograph the turmeric
with a yellow MTN reference card in the frame, complete a short form
about the vendor and their product, and share a brief educational
message about turmeric safety.

- Up to 20 deliveries per day
- Up to 5 deliveries per market
- About 10 minutes per visit

> Speaker notes: Set expectations on time per visit so the FLW knows what to budget for their day. Acknowledge that the cap is generous; quality matters more than count.

---

## Slide: Taking the photo

The photo + MTN card combination is the core verification artifact.
Without a clean photo, downstream analysts can't flag the vendor for
follow-up testing.

- Hold the MTN card flat, near the turmeric, both clearly visible
- Use natural light when possible; avoid harsh shadows
- Don't bend or fold the card — flat means flat
- The full card outline must be inside the frame

> Speaker notes: This is the most important step. If you doubt whether the photo is good, retake it. The form is salvageable later; the photo isn't.

---

## Slide: The education message

Share a friendly, non-confrontational message about turmeric safety.

- Frame: "I'm doing a survey and want to share information about turmeric quality"
- Mention that some turmeric contains lead, which is harmful
- Note that lead is sometimes added to make turmeric look brighter
- Vendors can protect customers by buying from trusted sources

> Speaker notes: Do not accuse the vendor of selling adulterated turmeric. The goal is information sharing, not confrontation. If they push back, thank them and move on.

---

## Slide: If a vendor refuses the photo

Some vendors won't agree to be photographed. That's fine.

- Complete the form anyway — the delivery is logged but flagged
- Be polite, thank them, and move on to the next vendor
- Record the refusal in the free-text notes if relevant

> Speaker notes: A flagged-but-recorded delivery is still useful data. Don't argue.

---

## Slide: When to escalate

Some situations need an LLO call, not a delivery.

- Broken MTN card → ask LLO for a replacement
- Vendor seems hostile or threatening → leave the market, contact LLO
- Verified adulteration claim → escalate up, do NOT diagnose on-site
- Phone or app problems blocking submission → contact LLO

> Speaker notes: Safety first. We'd rather have an unfinished day than an FLW in a bad situation.

---

## Slide: What you get paid for

You're paid per accepted delivery — one delivery is one vendor visit
that meets the verification criteria.

- 10 USD per accepted delivery
- Up to 200 USD per day (20 deliveries)
- Payment lands in your account weekly

> Speaker notes: Rejection of a delivery means it didn't meet verification (e.g., MTN card not visible). It's not punitive; it's a quality bar. Resubmissions are welcome.

---

## Slide: Where to get help

Two paths for questions, plus your LLO manager for logistics.

- OCS chat widget: ask anything about this opportunity, 24/7
- LLO manager: roster, scheduling, equipment issues
- For technical issues with the app, contact ACE program team

> Speaker notes: The OCS widget knows the program details — payment rules, the education script, what counts as a valid photo. Lean on it.
`;

async function main() {
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID!;
  const templateId = process.env.ACE_TRAINING_DECK_TEMPLATE_ID;
  if (!templateId) throw new Error('ACE_TRAINING_DECK_TEMPLATE_ID not set in .env');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Validate fixture exists
  if (!fs.existsSync(path.join(FIXTURE, 'pdd.md'))) {
    throw new Error(`Turmeric fixture not found at ${FIXTURE}`);
  }

  console.log('Step 1: parseDeckOutline (Turmeric content)');
  const spec = parseDeckOutline(TURMERIC_DECK_OUTLINE);
  console.log(`  title="${spec.title}"  slides=${spec.slides.length}`);
  spec.slides.forEach((s, i) => console.log(`    [${i + 1}] ${s.title}`));

  console.log('\nStep 2: buildSlidesRequests');
  const { mainRequests, speakerNotes } = buildSlidesRequests(spec, {
    stencils: { title: STENCIL_TITLE_OBJECT_ID, content: STENCIL_CONTENT_OBJECT_ID },
  });
  console.log(`  mainRequests=${mainRequests.length}  speakerNotes=${speakerNotes.length}`);

  console.log(`\nStep 3: copy template ${templateId} into Drive`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const deckTitle = `Turmeric Training Deck (${stamp})`;
  const copy = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: deckTitle, parents: [parentFolderId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const presentationId = copy.data.id!;
  console.log(`  presentationId=${presentationId}`);
  console.log(`  webViewLink=${copy.data.webViewLink}`);

  console.log('\nStep 4: main batchUpdate (fill placeholders, duplicate stencil)');
  const mainResp = await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: mainRequests as any[] },
  });
  console.log(`  replies=${mainResp.data.replies?.length}`);

  console.log('\nStep 5: discover speakerNotesObjectId per new slide');
  const getResp = await slides.presentations.get({ presentationId });
  const speakerNotesByObjectId: Record<string, string> = {};
  for (const slide of getResp.data.slides ?? []) {
    const slideId = slide.objectId!;
    const notesObjId =
      slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesObjId) speakerNotesByObjectId[slideId] = notesObjId;
  }
  console.log(`  resolved notes IDs for ${Object.keys(speakerNotesByObjectId).length} slides`);

  console.log('\nStep 6: speaker-notes batchUpdate');
  const notesRequests = buildSpeakerNotesRequests(speakerNotes, speakerNotesByObjectId);
  if (notesRequests.length > 0) {
    const notesResp = await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: notesRequests as any[] },
    });
    console.log(`  replies=${notesResp.data.replies?.length}`);
  }

  console.log('\n✓ Turmeric end-to-end deck build passed.');
  console.log(`  Open: ${copy.data.webViewLink}`);
  console.log(`  Slides: ${getResp.data.slides?.length} total`);
  console.log(`  Title: "${deckTitle}"`);
}

main().catch((e: any) => {
  console.error('\n✗ FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
