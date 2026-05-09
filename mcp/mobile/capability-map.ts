export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE';

export type Capability =
  | 'ensure_avd_running'
  | 'stop_avd'
  | 'list_avds'
  | 'install_apk'
  | 'uninstall_apk'
  | 'register_test_user'
  | 'run_recipe'
  | 'generate_recipes_from_app_summary'
  | 'capture_ui_dump'
  | 'save_snapshot'
  | 'load_snapshot';

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
  generate_recipes_from_app_summary: { backend: 'MAESTRO', description: 'LLM emits Maestro YAML from app summary' },
  capture_ui_dump: { backend: 'AVD', description: 'adb shell uiautomator dump' },
  save_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot save <name>' },
  load_snapshot: { backend: 'AVD', description: 'adb emu avd snapshot load <name>' },
};
