import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
const { buildSupervisorPlist, buildIntakePlist } = require('./launchd');
const { parseEnvFile, loadProtectedEnv } = require('../bin/launchd-runner');
const { ROOT } = require('./paths');

const envFile = path.join(ROOT, 'supervisor', 'daemon', 'intake.env.local');
const secret = 'must-not-appear-in-plist';

console.log('Test: launchd plists use protected env runner without embedding secrets');
for (const plist of [
  buildSupervisorPlist({ envFilePath: envFile, maxConcurrent: 2, extraEnv: { TEST_SECRET: secret }, opServiceAccountToken: secret }),
  buildIntakePlist({ envFilePath: envFile, extraEnv: { TEST_SECRET: secret }, opServiceAccountToken: secret }),
]) {
  assert.ok(plist.includes('launchd-runner.js'));
  assert.ok(plist.includes('CCP_ENV_FILE'));
  assert.ok(plist.includes(envFile));
  assert.ok(plist.includes('<string>/Users/kyan</string>'));
  assert.ok(!plist.includes(secret));
  assert.ok(!plist.includes('TEST_SECRET'));
  assert.ok(!plist.includes('OP_SERVICE_ACCOUNT_TOKEN'));
}
assert.ok(buildSupervisorPlist({ envFilePath: envFile, maxConcurrent: 2 }).includes('--max-concurrent=2'));
const customPortPlist = buildIntakePlist({ envFilePath: envFile, port: 54321 });
assert.ok(customPortPlist.includes('<key>CCP_INTAKE_PORT</key>'));
assert.ok(customPortPlist.includes('<string>54321</string>'));
assert.throws(() => buildIntakePlist({ port: '"54321"' }), /CCP_INTAKE_PORT must be an integer/);
assert.throws(() => buildSupervisorPlist({ maxConcurrent: 'not-a-number' }), /CCP_MAX_CONCURRENT must be an integer/);

console.log('Test: protected env parsing and file hardening');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-launchd-env-'));
const protectedFile = path.join(tempDir, 'env.local');
fs.writeFileSync(protectedFile, '# comment\nCCP_TEST_QUOTED="quoted value"\nCCP_TEST_PLAIN=plain\n', { mode: 0o600 });
assert.deepEqual(parseEnvFile(protectedFile), { CCP_TEST_QUOTED: 'quoted value', CCP_TEST_PLAIN: 'plain' });
loadProtectedEnv(protectedFile);
assert.equal(process.env.CCP_TEST_QUOTED, 'quoted value');
delete process.env.CCP_TEST_QUOTED;
delete process.env.CCP_TEST_PLAIN;
fs.chmodSync(protectedFile, 0o644);
assert.throws(() => loadProtectedEnv(protectedFile), /permissions must be 0600/);
fs.chmodSync(protectedFile, 0o600);
const symlinkFile = path.join(tempDir, 'env-link');
fs.symlinkSync(protectedFile, symlinkFile);
assert.throws(() => loadProtectedEnv(symlinkFile), /regular file, not a symlink/);
const malformedFile = path.join(tempDir, 'malformed.env');
fs.writeFileSync(malformedFile, 'NOT-VALID=value\n', { mode: 0o600 });
assert.throws(() => parseEnvFile(malformedFile), /invalid environment key/);
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('launchd tests passed');
