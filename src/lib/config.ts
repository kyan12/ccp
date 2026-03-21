import fs = require('fs');
import path = require('path');
const { ROOT } = require('./paths');

const CONFIG_DIR: string = path.join(ROOT, 'configs');

function readJsonIfExists(file: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig<T = Record<string, unknown>>(name: string, fallback: T = {} as T): T {
  const primary = path.join(CONFIG_DIR, `${name}.json`);
  const example = path.join(CONFIG_DIR, `${name}.json.example`);
  return (readJsonIfExists(primary) || readJsonIfExists(example) || fallback) as T;
}

function saveConfig(name: string, data: unknown): void {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

module.exports = {
  CONFIG_DIR,
  loadConfig,
  saveConfig,
};

export { CONFIG_DIR, loadConfig, saveConfig };
