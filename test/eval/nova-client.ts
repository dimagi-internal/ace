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
            rawText: '',
            error: data.message,
          };
        }
      } catch {}
    }
  }

  // Extract JSON blueprint from markdown code block
  const blueprint = extractBlueprint(resultText);

  return { blueprint, sessionId: resultSessionId, durationMs, tokenUsage, rawText: resultText };
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
- Have 5 scenario-based multiple choice questions
- Include a hidden "score" question that calculates percentage correct (each correct answer = 20 points)
- Configure Connect learn_module (with description) and assessment (with score_question and passing_score of 80) on each form

No case management — pure training/assessment app.

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

Do not ask clarifying questions — generate the app directly from this spec.

## IDD

${idd}`;
}
