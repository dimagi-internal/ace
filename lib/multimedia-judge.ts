//
// LLM judge — for one CommCare app field, decide whether to generate
// a display-only image. Criterion: would the FLW use the image themselves
// (e.g. step-by-step demo) OR show it to a client (e.g. choice card)?
// Either-yes triggers generation.
//
// Application Context is constant for every field in an opp, so it sits in
// a prompt-cached system block. The per-field payload is the only variation.

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

export const judgeOutputSchema = z.object({
  generate: z.boolean(),
  use_case: z.enum(['flw_self_use', 'flw_shows_client', 'both']).optional().nullable(),
  why: z.string().min(1).max(500),
  directive: z.string().max(800).nullable(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface JudgeInput {
  appContext: string;
  appType: 'learn' | 'deliver';
  formName: string;
  formPosition: string;
  field: {
    id: string;
    kind: string;
    label: string;
    hint: string | null;
    options: string[];
  };
  surroundingFields: Array<{ id: string; kind: string; label: string }>;
}

const SYSTEM_HEAD = `You decide whether to generate a display-only image for a single CommCare app question.

Criterion (yes if EITHER applies):
1. The frontline worker (FLW) would use this image themselves to do their job — e.g. a step-by-step demonstration, a labeled diagram of an anatomy or device.
2. The FLW would show the image to a client to communicate something — e.g. a visual choice card, a "what does X look like" reference.

Skip if the question is purely numeric (weight, age), date/time, or a yes/no without ambiguity. Skip if the question's text alone is unambiguous and concrete.

Return STRICT JSON only, matching this schema:
{
  "generate": boolean,
  "use_case": "flw_self_use" | "flw_shows_client" | "both" | null,
  "why": "short rationale, ≤200 chars",
  "directive": "draft Image Directive for the generator, ≤500 chars, or null if generate=false"
}

Image Directive guidance: be specific about the subject, action, environment, lighting, and any modesty/representation cues from the application context. The directive will be passed verbatim to an image generator.`;

export async function judgeField(
  input: JudgeInput,
  anthropic: Anthropic,
  model = 'claude-sonnet-4-6',
): Promise<JudgeOutput> {
  const userPayload = {
    app_type: input.appType,
    form_name: input.formName,
    form_position: input.formPosition,
    field: input.field,
    surrounding_fields: input.surroundingFields,
  };

  const res = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system: [
      { type: 'text', text: SYSTEM_HEAD },
      {
        type: 'text',
        text: `Application Context (constant for this opp):\n${input.appContext}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  });

  const textBlock = (res.content as Array<{ type: string; text?: string }>).find(
    b => b.type === 'text',
  );
  const text = textBlock?.text ?? '';
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`judge returned non-JSON: ${text.slice(0, 200)}`);
  }
  return judgeOutputSchema.parse(parsed);
}
