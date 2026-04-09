export function loadRestToken(): string {
  const token = process.env.OCS_API_TOKEN;
  if (!token) {
    throw new Error('OCS_API_TOKEN env var is required for REST backend');
  }
  return token;
}

export function loadBaseUrl(): string {
  return process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
}
