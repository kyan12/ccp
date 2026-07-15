import fs = require('fs');
import os = require('os');
import path = require('path');
import {
  isLinearDispatchDisabled,
  dispatchLinearIssues,
} from './linear-dispatch';

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

console.log('\nTest: Linear dispatch disable switch recognizes truthy env values');
{
  process.env.CCP_LINEAR_DISABLED = 'true';
  assert(isLinearDispatchDisabled() === true, 'CCP_LINEAR_DISABLED=true disables dispatch');
  process.env.CCP_LINEAR_DISABLED = '1';
  assert(isLinearDispatchDisabled() === true, 'CCP_LINEAR_DISABLED=1 disables dispatch');
  process.env.CCP_LINEAR_DISABLED = 'yes';
  assert(isLinearDispatchDisabled() === true, 'CCP_LINEAR_DISABLED=yes disables dispatch');
  process.env.CCP_LINEAR_DISABLED = 'false';
  assert(isLinearDispatchDisabled() === false, 'CCP_LINEAR_DISABLED=false does not disable dispatch');
  delete process.env.CCP_LINEAR_DISABLED;
}

async function main(): Promise<void> {
  console.log('\nTest: dispatchLinearIssues no-ops cleanly when Linear is disabled');
  {
    process.env.CCP_LINEAR_DISABLED = 'true';
    const out = await dispatchLinearIssues();
    assert(Array.isArray(out), 'returns an array');
    assert(out.length === 0, 'returns no dispatched issues');
    delete process.env.CCP_LINEAR_DISABLED;
  }

  console.log('\nTest: supervisor cycle runs with Linear disabled and records no Linear error');
  {
    process.env.CCP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-linear-disabled-supervisor-'));
    process.env.CCP_LINEAR_DISABLED = 'true';
    const { runSupervisorCycle } = require('./jobs');
    const out = await runSupervisorCycle({ maxConcurrent: 0 });
    assert(Array.isArray(out.linearDispatched) && out.linearDispatched.length === 0, 'supervisor linearDispatched is empty');
    const linearErrors = (out.errors || []).filter((e: { action?: string }) => e.action === 'linear-dispatch');
    assert(linearErrors.length === 0, 'supervisor has no linear-dispatch error when disabled');
    delete process.env.CCP_LINEAR_DISABLED;
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
