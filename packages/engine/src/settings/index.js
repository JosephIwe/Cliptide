/**
 * Public surface of the settings layer.
 */

export { SettingsStore } from './store.js';
export {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  DEFAULT_SUMMON_SHORTCUT,
  validateSettings,
  validateShortcut,
} from './schema.js';
