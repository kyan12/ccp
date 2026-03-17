const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');

const CONFIG_DIR = path.join(ROOT, 'configs');

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig(name, fallback = {}) {
  const primary = path.join(CONFIG_DIR, `${name}.json`);
  const example = path.join(CONFIG_DIR, `${name}.json.example`);
  return readJsonIfExists(primary) || readJsonIfExists(example) || fallback;
}

module.exports = {
  CONFIG_DIR,
  loadConfig,
};
