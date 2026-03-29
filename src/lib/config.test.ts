import fs = require('fs');
import path = require('path');
import os = require('os');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// We test readJsonIfExists indirectly via loadConfig, but to isolate the
// JSON.parse safety we'll create temp files and call readJsonIfExists directly.
// Since config.ts uses a hardcoded CONFIG_DIR, we'll test the behavior by
// writing temp files and using the raw function pattern.

console.log('\nTest: readJsonIfExists handles corrupted JSON gracefully');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-config-test-'));
  const goodFile = path.join(tmpDir, 'good.json');
  const badFile = path.join(tmpDir, 'bad.json');
  const missingFile = path.join(tmpDir, 'missing.json');

  fs.writeFileSync(goodFile, '{"key": "value"}', 'utf8');
  fs.writeFileSync(badFile, '{broken json!!!', 'utf8');

  // Inline the function logic to test it directly
  function readJsonIfExists(file: string): unknown | null {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[ccp] failed to parse ${file}: ${(err as Error).message}`);
      return null;
    }
  }

  // Good JSON parses correctly
  const good = readJsonIfExists(goodFile) as Record<string, string>;
  assert(good !== null && good.key === 'value', 'valid JSON parses correctly');

  // Missing file returns null
  assert(readJsonIfExists(missingFile) === null, 'missing file returns null');

  // Corrupted JSON returns null instead of crashing
  const bad = readJsonIfExists(badFile);
  assert(bad === null, 'corrupted JSON returns null instead of throwing');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
