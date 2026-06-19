import fs = require('fs');
import os = require('os');
import path = require('path');
import { spawnSync, type SpawnSyncReturns } from 'child_process';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function runNightlyWithRepos(reposJson: string): SpawnSyncReturns<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-nightly-compound-'));
  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'configs', 'repos.json'), reposJson);
  return spawnSync(process.execPath, [path.join(__dirname, 'nightly-compound.js'), '--list'], {
    cwd: root,
    env: { ...process.env, CCP_ROOT: root },
    encoding: 'utf8',
  });
}

console.log('\nTest: nightly-compound handles missing mappings gracefully');
{
  const result = runNightlyWithRepos('{}\n');
  assert(result.status === 0, 'command exits successfully');
  assert(/Nightly-eligible repos/.test(result.stdout || ''), 'list output is still rendered');
  assert(/mappings must be an array/.test(result.stderr || ''), 'invalid shape is logged');
}

console.log('\nTest: nightly-compound handles malformed repos JSON gracefully');
{
  const result = runNightlyWithRepos('{not json');
  assert(result.status === 0, 'command exits successfully');
  assert(/Nightly-eligible repos/.test(result.stdout || ''), 'list output is still rendered');
  assert(/failed to read\/parse/.test(result.stderr || ''), 'parse failure is logged');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
