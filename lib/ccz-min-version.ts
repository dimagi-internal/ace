/**
 * STUB — ace#1997, red step. Encodes ACE's behaviour BEFORE the preventer:
 * nothing compares the released CCZ's minimum CommCare version against the
 * APK Phase 6 runs, and version strings are compared lexicographically.
 * Replaced in the next commit.
 */
export interface VersionTriple { major: number; minor: number; patch: number }

export function parseVersionTriple(s: string): VersionTriple | null {
  const [a, b, c] = String(s).split('.');
  return { major: Number(a), minor: Number(b), patch: Number(c) };
}

export function compareVersionTriples(a: VersionTriple, b: VersionTriple): -1 | 0 | 1 {
  const sa = `${a.major}.${a.minor}.${a.patch}`;
  const sb = `${b.major}.${b.minor}.${b.patch}`;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function parseCczRequiredVersion(xml: string): {
  status: 'parsed' | 'absent' | 'malformed';
  version: VersionTriple | null;
} {
  const maj = /requiredMajor="(\d+)"/.exec(xml);
  const min = /requiredMinor="(\d+)"/.exec(xml);
  if (!maj || !min) return { status: 'absent', version: null };
  const pat = /requiredMinimal="(\d+)"/.exec(xml);
  return {
    status: 'parsed',
    version: { major: Number(maj[1]), minor: Number(min[1]), patch: pat ? Number(pat[1]) : 0 },
  };
}

export interface CczMinVersionFinding {
  kind: 'ccz-min-version-gate' | 'ccz-profile-unreadable' | 'apk-version-unreadable';
  app: string;
  requiredVersion: string | null;
  apkVersion: string | null;
  message: string;
  remedy: string;
}

export interface CczMinVersionOutcome {
  severity: 'ok' | 'info' | 'warn' | 'blocker';
  finding: CczMinVersionFinding | null;
}

export function checkCczMinVersion(_input: {
  app: string;
  profileXml: string;
  apkVersion: string;
  selectorMapVersions?: string[];
  devicePhasePlanned?: boolean;
}): CczMinVersionOutcome {
  // Today: Phase 3 has no minimum-version gate at all.
  return { severity: 'ok', finding: null };
}
