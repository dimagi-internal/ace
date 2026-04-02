/**
 * Nova API client for ACE evaluation.
 * Drives Nova's /api/claude-code endpoint, parses SSE, extracts blueprints.
 */

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

  const resp = await fetch(`${NOVA_URL}/api/claude-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    return {
      blueprint: null,
      sessionId: '',
      durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      rawText: '',
      error: `HTTP ${resp.status}: ${await resp.text()}`,
    };
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resultSessionId = '';
  let resultText = '';
  let streamedText = ''; // Accumulate all text events as fallback
  let durationMs = 0;
  let tokenUsage = { inputTokens: 0, outputTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
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
            blueprint: null,
            sessionId: resultSessionId,
            durationMs,
            tokenUsage,
            rawText: streamedText,
            error: data.message,
          };
        }
      } catch {}
    }
  }

  // Try result text first, fall back to accumulated streamed text
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
  return `Build a CommCare Connect LEARN app based on the following Intervention Design Document.

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

## IDD

${idd}`;
}

export function buildDeliverPrompt(idd: string): string {
  return `Build a CommCare Connect DELIVER app based on the following Intervention Design Document.

This is a Connect Deliver app — set connect_type to "deliver".

Use the Deliver App Specification section to create the app. Follow these guidelines:
- Create one module per major workflow step (registration, service delivery, follow-up)
- Registration forms should create cases, follow-up forms should update cases
- Configure Connect deliver_unit on all forms
- Configure Connect task on service delivery and follow-up forms (not registration)
- Include all case properties specified in the IDD
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

## IDD

${idd}`;
}
