/**
 * Nova API client for ACE evaluation.
 * Drives Nova's /api/claude-code endpoint, parses SSE, extracts blueprints.
 * Uses curl subprocess to avoid Node fetch body timeout issues with long SSE streams.
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface NovaResult {
  blueprint: Record<string, unknown> | null;
  sessionId: string;
  durationMs: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
  rawText: string;
  error?: string;
}

const NOVA_URL = process.env.NOVA_URL || 'http://localhost:3000';

export async function generateApp(prompt: string, sessionId?: string): Promise<NovaResult> {
  const body: Record<string, unknown> = { prompt };
  if (sessionId) body.sessionId = sessionId;

  const bodyFile = join(tmpdir(), `nova-req-${Date.now()}.json`);
  const outFile = join(tmpdir(), `nova-resp-${Date.now()}.txt`);

  writeFileSync(bodyFile, JSON.stringify(body));

  try {
    execSync(
      `curl -sN -X POST ${NOVA_URL}/api/claude-code -H "Content-Type: application/json" -d @${bodyFile} > ${outFile}`,
      { timeout: 15 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (e: any) {
    return {
      blueprint: null, sessionId: '', durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      rawText: '', error: `curl failed: ${e.message?.slice(0, 200)}`,
    };
  } finally {
    try { unlinkSync(bodyFile); } catch {}
  }

  // Parse SSE output
  let raw: string;
  try {
    raw = readFileSync(outFile, 'utf-8');
  } catch {
    return {
      blueprint: null, sessionId: '', durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      rawText: '', error: 'No output from Nova',
    };
  } finally {
    try { unlinkSync(outFile); } catch {}
  }

  let resultSessionId = '';
  let resultText = '';
  let streamedText = '';
  let durationMs = 0;
  let tokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'init') {
        resultSessionId = data.sessionId;
      } else if (data.type === 'text') {
        streamedText += data.text;
      } else if (data.type === 'result') {
        resultText = data.text;
        durationMs = data.durationMs || 0;
        tokenUsage = data.usage || tokenUsage;
        if (!resultSessionId) resultSessionId = data.sessionId;
      } else if (data.type === 'error') {
        return {
          blueprint: null, sessionId: resultSessionId, durationMs, tokenUsage,
          rawText: streamedText, error: data.message,
        };
      }
    } catch {}
  }

  const textToSearch = resultText || streamedText;
  const blueprint = extractBlueprint(textToSearch);

  return { blueprint, sessionId: resultSessionId, durationMs, tokenUsage, rawText: textToSearch };
}

function extractBlueprint(text: string): Record<string, unknown> | null {
  // Try to find ```json ... ``` block
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {}
  }
  // Try to find raw JSON object
  const objMatch = text.match(/\{[\s\S]*"app_name"[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {}
  }
  return null;
}

export function buildLearnPrompt(idd: string): string {
  return `Build a CommCare Connect LEARN app based on the following Program Design Document.

This is a Connect Learn app — set connect_type to "learn".

Use the Learn App Specification section to create training modules. Each module should:
- Be a separate module with one quiz form
- Have 7-8 scenario-based multiple choice questions for robust assessment
- Include a hidden "score" question that calculates percentage correct
- Configure Connect learn_module (with description) and assessment (with score_question and passing_score of 80) on each form

## Quality requirements — these are critical:
- Keep question labels concise (under 30 words) — these will be read on small Android screens by CHWs
- Add a hint on each question with additional context if the scenario needs more detail
- Before each quiz, add a "label" type question with a brief lesson summary (3-4 sentences) so the CHW gets instructional content before assessment
- Make select options short and clearly distinguishable
- No case management — pure training/assessment app

Do not ask clarifying questions — generate the app directly from this spec.

## PDD

${idd}`;
}

export function buildDeliverPrompt(idd: string): string {
  return `Build a CommCare Connect DELIVER app based on the following Program Design Document.

This is a Connect Deliver app — set connect_type to "deliver".

Use the Deliver App Specification section to create the app. Follow these guidelines:
- Create one module per major workflow step (registration, service delivery, follow-up)
- Registration forms should create cases, follow-up forms should update cases
- Configure Connect deliver_unit on all forms
- Configure Connect task on service delivery and follow-up forms (not registration)
- Include all case properties specified in the PDD
- Add appropriate validation constraints
- Include conditional case closure where specified

## Quality requirements — these are critical:
- Use calculated/hidden fields for values that can be derived (e.g., nets_needed = children_under_5 + pregnant_women - existing_good_nets). Do NOT make the CHW manually enter values that can be computed.
- Add case list filter expressions so CHWs only see cases at the right stage (e.g., distribution module only shows "registered" cases, verification only shows "nets_distributed" cases). Use a case property like "status" to track stage.
- For conditional case closure, check specific conditions (e.g., close only if all nets installed AND in use), not unconditional
- Add a brief introductory "label" question at the top of each form explaining what the CHW should do
- Keep question labels concise for mobile screens
- Add hints on fields where the expected input might be unclear

Do not ask clarifying questions — generate the app directly from this spec.

## PDD

${idd}`;
}
