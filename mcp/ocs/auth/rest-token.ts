export function loadRestToken(): string {
  return process.env.OCS_API_TOKEN ?? '';
}

export function loadBaseUrl(): string {
  return process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
}
