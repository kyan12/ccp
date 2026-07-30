import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import { spawnSync } from 'child_process';

console.log('Test: installer normalizes quoted numeric env values and canonicalizes managed flags');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-install-launchd-'));
const home = path.join(root, 'home');
const envFile = path.join(root, 'supervisor', 'daemon', 'intake.env.local');
fs.mkdirSync(path.dirname(envFile), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(envFile, [
  'CCP_INTAKE_PORT="54321"',
  "CCP_MAX_CONCURRENT='2'",
  'CCP_LINEAR_DISABLED=0',
  'CCP_DISABLE_LINEAR=0',
  'LINEAR_API_KEY=fake-retired-value',
  'SAFE_TEST_VALUE=keep-me',
  '',
].join('\n'), { mode: 0o600 });

const installer = path.join(process.cwd(), 'dist', 'bin', 'install-launchd.js');
const result = spawnSync(process.execPath, [installer], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin',
    CCP_ROOT: root,
    CCP_HOST_HOME: home,
  },
});
assert.equal(result.status, 0, result.stderr || result.stdout);

const supervisorPath = path.join(home, 'Library', 'LaunchAgents', 'ai.ccp.supervisor.plist');
const intakePath = path.join(home, 'Library', 'LaunchAgents', 'ai.ccp.intake.plist');
const supervisorPlist = fs.readFileSync(supervisorPath, 'utf8');
const intakePlist = fs.readFileSync(intakePath, 'utf8');
assert.ok(supervisorPlist.includes('<string>--max-concurrent=2</string>'));
assert.ok(intakePlist.includes('<key>CCP_INTAKE_PORT</key>'));
assert.ok(intakePlist.includes('<string>54321</string>'));
assert.ok(!supervisorPlist.includes('NaN'));
assert.ok(!intakePlist.includes('NaN'));

const finalLines = fs.readFileSync(envFile, 'utf8').trim().split(/\r?\n/);
assert.equal(finalLines.filter((line) => line.startsWith('CCP_LINEAR_DISABLED=')).length, 1);
assert.equal(finalLines.filter((line) => line.startsWith('CCP_DISABLE_LINEAR=')).length, 1);
assert.ok(finalLines.includes('CCP_LINEAR_DISABLED=1'));
assert.ok(finalLines.includes('CCP_DISABLE_LINEAR=1'));
assert.ok(!finalLines.some((line) => line.startsWith('LINEAR_')));
assert.ok(finalLines.includes('SAFE_TEST_VALUE=keep-me'));

fs.rmSync(root, { recursive: true, force: true });
console.log('install-launchd tests passed');
