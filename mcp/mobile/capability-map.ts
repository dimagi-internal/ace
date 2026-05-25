export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE' | 'CLOUD';
// CLOUD = ace-web's cloud emulator (HTTP API). Selected at runtime
// when ACE_MOBILE_BACKEND=cloud is set; otherwise the existing
// AVD/MAESTRO/COMPOSITE backends drive a local emulator.

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
  | 'probe_maestro_driver'
  | 'diagnose'
  | 'restart_runner'
  | 'patch_launch_script';

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
  register_test_user: { backend: 'COMPOSITE', description: 'Two-part Maestro registration via +7426 demo-bypass prefix (no OTP)' },
  run_recipe: { backend: 'MAESTRO', description: 'maestro test <recipe>' },
  validate_recipe: { backend: 'MAESTRO', description: 'Lint a Maestro YAML body (step-key allowlist + structural checks) without running it' },
  resolve_selectors: { backend: 'MAESTRO', description: 'Substitute ${SELECTOR:name} placeholders in a Maestro YAML body from mcp/mobile/selectors/connect-<apkVersion>.yaml' },
  capture_ui_dump: { backend: 'AVD', description: 'adb shell uiautomator dump' },
  save_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot save <name>' },
  load_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot load <name>' },
  probe_maestro_driver: { backend: 'MAESTRO', description: 'Read-only: does the on-device Maestro driver gRPC channel respond on the AVD? No recovery — use ensure_avd_running for the heal path.' },
  diagnose: { backend: 'CLOUD', description: 'Cloud-only: read the runner-VM diagnostics (SSM state, runner-ready marker, last recipe). Throws CLOUD_ONLY_OPERATION on local AVD.' },
  restart_runner: { backend: 'CLOUD', description: 'Cloud-only: restart the in-VM runner process. Throws CLOUD_ONLY_OPERATION on local AVD.' },
  patch_launch_script: { backend: 'CLOUD', description: 'Cloud-only: overwrite /usr/local/bin/ace-emulator-launch on the runner VM (server enforces a 64KB cap). Throws CLOUD_ONLY_OPERATION on local AVD.' },
};

// Note: `mobile_generate_recipes_from_app_summary` is intentionally NOT
// registered as an MCP atom — it's invoked programmatically by skills
// via MobileClient because it requires a Drive adapter + LLM function
// as inputs that don't fit cleanly into MCP tool schemas. The
// capability-map tracks ATOMS, so it stays absent here.
