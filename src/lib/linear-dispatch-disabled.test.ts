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
  assert(isLinearDispatchDisabled() === true, 'durable configs/linear.json disable still blocks dispatch when CCP_LINEAR_DISABLED=false');
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


  console.log('\nTest: syncJobToLinear no-ops before credentials/API when global Linear is disabled');
  {
    delete process.env.LINEAR_API_KEY;
    process.env.CCP_LINEAR_DISABLED = '1';
    const https = require('https');
    const originalRequest = https.request;
    let requestCount = 0;
    https.request = function blockedLinearRequest(...args: unknown[]) {
      requestCount++;
      throw new Error('unexpected Linear API request');
    };
    try {
      const { syncJobToLinear } = require('./linear');
      const sync = await syncJobToLinear({
        packet: { job_id: 'job_disabled_env', ticket_id: 'PRO-1', repo: '/tmp/repo', goal: 'disabled', source: 'linear', kind: 'fix', label: 'test' },
        status: { job_id: 'job_disabled_env', ticket_id: 'PRO-1', repo: '/tmp/repo', state: 'done', started_at: null, updated_at: new Date().toISOString(), elapsed_sec: 0, tmux_session: null, last_heartbeat_at: null, last_output_excerpt: '', exit_code: 0 },
        result: { job_id: 'job_disabled_env', state: 'done', commit: 'abc123', prod: 'no', verified: 'test', blocker: null },
      });
      assert(sync.skipped === true, 'sync reports skipped');
      assert(/linear disabled/i.test(String(sync.reason || '')), 'skip reason is explicit Linear-disabled');
      assert(requestCount === 0, 'does not attempt Linear API request');
    } finally {
      https.request = originalRequest;
      delete process.env.CCP_LINEAR_DISABLED;
    }
  }

  console.log('\nTest: syncJobToLinear skips Hermes Kanban packets even without global disable env');
  {
    process.env.LINEAR_API_KEY = 'fake-key-that-must-not-be-used';
    delete process.env.CCP_LINEAR_DISABLED;
    delete process.env.CCP_DISABLE_LINEAR;
    const https = require('https');
    const originalRequest = https.request;
    let requestCount = 0;
    https.request = function blockedLinearRequest(...args: unknown[]) {
      requestCount++;
      throw new Error('unexpected Linear API request');
    };
    try {
      const { syncJobToLinear } = require('./linear');
      const sync = await syncJobToLinear({
        packet: { job_id: 'kanban_t_sync', ticket_id: 't_sync001', repo: '/tmp/repo', goal: 'kanban', source: 'hermes-kanban', kind: 'fix', label: 'test', metadata: { source_transport: 'hermes-kanban' } },
        status: { job_id: 'kanban_t_sync', ticket_id: 't_sync001', repo: '/tmp/repo', state: 'verified', started_at: null, updated_at: new Date().toISOString(), elapsed_sec: 0, tmux_session: null, last_heartbeat_at: null, last_output_excerpt: '', exit_code: 0 },
        result: { job_id: 'kanban_t_sync', state: 'verified', commit: 'abc123', prod: 'no', verified: 'test', blocker: null },
      });
      assert(sync.skipped === true, 'Hermes Kanban sync reports skipped');
      assert(/hermes kanban|linear disabled/i.test(String(sync.reason || '')), 'skip reason names Hermes Kanban/Linear-disabled path');
      assert(requestCount === 0, 'Hermes Kanban packet does not attempt Linear API request');
    } finally {
      https.request = originalRequest;
      delete process.env.LINEAR_API_KEY;
    }
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
