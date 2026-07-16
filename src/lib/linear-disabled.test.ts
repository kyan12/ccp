import fs = require('fs');
import os = require('os');
import path = require('path');

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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-linear-disabled-test-'));
process.env.CCP_ROOT = TEST_ROOT;
fs.mkdirSync(path.join(TEST_ROOT, 'configs'), { recursive: true });

const {
  isLinearGloballyDisabled,
  linearDisabledReasonForPacket,
} = require('./linear-disabled');

function clearLinearDisableEnv(): void {
  delete process.env.CCP_LINEAR_DISABLED;
  delete process.env.CCP_DISABLE_LINEAR;
}

console.log('\nTest: Linear disable env aliases are evaluated independently');
{
  process.env.CCP_LINEAR_DISABLED = 'false';
  process.env.CCP_DISABLE_LINEAR = 'true';
  assert(isLinearGloballyDisabled() === true, 'CCP_DISABLE_LINEAR=true disables even when CCP_LINEAR_DISABLED=false');
  assert(/CCP_LINEAR_DISABLED\/CCP_DISABLE_LINEAR/.test(String(linearDisabledReasonForPacket({ source: 'linear' }) || '')), 'env disable reason names env aliases');
  clearLinearDisableEnv();
}

console.log('\nTest: Linear disable reason names config-file source');
{
  fs.writeFileSync(path.join(TEST_ROOT, 'configs', 'linear.json'), JSON.stringify({ disabled: true }, null, 2) + '\n');
  assert(isLinearGloballyDisabled() === true, 'configs/linear.json disabled=true disables Linear');
  const reason = String(linearDisabledReasonForPacket({ source: 'linear' }) || '');
  assert(/configs\/linear\.json|linear\.json|config/i.test(reason), 'config disable reason names config file source');
  assert(!/CCP_LINEAR_DISABLED\/CCP_DISABLE_LINEAR/.test(reason), 'config disable reason does not claim env aliases caused disable');
  fs.rmSync(path.join(TEST_ROOT, 'configs', 'linear.json'), { force: true });
}


console.log('\nTest: Linear disable config flags disable dispatch/poll/sync as defense in depth');
{
  clearLinearDisableEnv();
  fs.writeFileSync(path.join(TEST_ROOT, 'configs', 'linear.json'), JSON.stringify({
    apiKeyEnv: 'LINEAR_API_KEY',
    disabled: true,
    dispatchEnabled: false,
    pollingEnabled: false,
    syncEnabled: false,
  }, null, 2) + '\n');
  assert(isLinearGloballyDisabled() === true, 'configs/linear.json disabled=true with dispatch/poll/sync false disables Linear globally');
  const reason = String(linearDisabledReasonForPacket({ source: 'linear' }) || '');
  assert(/configs\/linear\.json|linear\.json|config/i.test(reason), 'durable config disable reports config source');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
