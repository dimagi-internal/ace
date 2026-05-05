import { createHash } from 'node:crypto';

export interface PromptHashInput {
  appContext: string;
  formText: string;
  directive: string | null | undefined;
}

export function promptHash(input: PromptHashInput): string {
  const norm = (s: string | null | undefined) => (s ?? '').trim();
  const payload = [norm(input.appContext), norm(input.formText), norm(input.directive)].join(' ');
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}
