export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE';
// The route names the LOCAL mechanism. On the `lease` backend
// (backends/lease.ts, selected at runtime — backend-toggle.ts) every atom
// routes to the leased machine's `ace-mobile` CLI instead.

export type Capability =
  | 'ensure_avd_running'
  | 'stop_avd'
  | 'list_avds'
  | 'install_apk'
  | 'uninstall_apk'
  | 'register_test_user'
  | 'run_recipe'
  | 'validate_recipe'
  | 'resolve_selectors'
  | 'capture_ui_dump'
  | 'save_snapshot'
  | 'load_snapshot'
  | 'set_location'
  | 'probe_maestro_driver'
  | 'list_session_videos'
  | 'clear_session_videos'
  | 'diagnose'
  | 'checkout_test_workers'
  | 'release_test_workers';

export interface CapabilityRoute {
  backend: Backend;
  description: string;
}

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  ensure_avd_running: { backend: 'AVD', description: 'Boot the AVD if cold; idempotent' },
  stop_avd: { backend: 'AVD', description: 'Graceful AVD shutdown' },
  list_avds: { backend: 'AVD', description: 'List AVDs known to avdmanager' },
  install_apk: { backend: 'AVD', description: 'adb install -r' },
  uninstall_apk: { backend: 'AVD', description: 'adb uninstall' },
  register_test_user: { backend: 'COMPOSITE', description: 'Two-part Maestro registration via +7426 demo-bypass prefix (no OTP). Signs in as a held pool worker (`slot`), the session\'s own worker, or an explicit unlocked identity (ace#2955)' },
  run_recipe: { backend: 'MAESTRO', description: 'maestro test <recipe>' },
  validate_recipe: { backend: 'MAESTRO', description: 'Lint a Maestro YAML body (step-key allowlist + structural checks) without running it' },
  resolve_selectors: { backend: 'MAESTRO', description: 'Substitute ${SELECTOR:name} placeholders in a Maestro YAML body from mcp/mobile/selectors/connect-<apkVersion>.yaml' },
  capture_ui_dump: { backend: 'AVD', description: 'adb shell uiautomator dump' },
  save_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot save <name>' },
  load_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot load <name>' },
  set_location: { backend: 'AVD', description: 'adb emu geo fix <lon> <lat> [alt] [sats] — seed a mock GPS fix so CommCare geopoint Capture works. Cold-boot baseline seeds a default; this overrides per-opp. Local AVD + lease (`ace-mobile set-location` beside the emulator).' },
  probe_maestro_driver: { backend: 'MAESTRO', description: 'Read-only: does the on-device Maestro driver gRPC channel respond on the AVD? No recovery — use ensure_avd_running for the heal path.' },
  list_session_videos: { backend: 'AVD', description: "Host-side: list the mp4s this session's local recipe runs spooled to ~/.ace/mobile-videos/<ppid>/, plus the spool dir. The ppid keys the spool and belongs to the MCP process, so skills cannot resolve it themselves." },
  clear_session_videos: { backend: 'AVD', description: "Host-side: clear THIS session's video spool (scoped to the MCP's own ppid, so it cannot touch a concurrent session's spool). Returns the number of files removed." },
  diagnose: { backend: 'COMPOSITE', description: 'Dual-mode read-only probe (ace#961). Lease: the `ace-mobile diagnose` snapshot from the leased machine (adb devices, emulator state) plus the lease (id, status, instance, expiry). Local: the adb server port this session actually allocated (raw `adb` defaults to 5037 and sees nothing), plus emulator ports, visible devices on THAT port, and the running AVD. Discriminate on the `backend` field.' },
  checkout_test_workers: { backend: 'COMPOSITE', description: "Hold N Connect test workers exclusively through canopy-web's `test-worker` pool capability (ace#2955) — for multi-worker tests. Waits for queued slots, fails loud naming holders, never shares a worker." },
  release_test_workers: { backend: 'COMPOSITE', description: 'Release Connect test workers this session holds (default: all but the signed-in one). mobile_stop_avd releases every one.' },
};

// Note: `mobile_generate_recipes_from_app_summary` is intentionally NOT
// registered as an MCP atom — it's invoked programmatically by skills
// via MobileClient because it requires a Drive adapter + LLM function
// as inputs that don't fit cleanly into MCP tool schemas. The
// capability-map tracks ATOMS, so it stays absent here.
