import assert = require('node:assert/strict');
import crypto = require('node:crypto');
import fs = require('node:fs');
import http = require('node:http');
import os = require('node:os');
import path = require('node:path');
import { spawn } from 'node:child_process';
import test = require('node:test');

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

function post(port: number, rawBody: Buffer, signature = '', includeContentLength = true): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ingest/sentry',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(includeContentLength ? { 'content-length': String(rawBody.length) } : {}),
        ...(signature ? { 'sentry-hook-signature': signature } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, body: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

async function withIntakeServer(run: (port: number, marker: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-sentry-http-'));
  const marker = path.join(root, 'hermes-called');
  const fakeHermes = path.join(root, 'hermes');
  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.writeFileSync(fakeHermes, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const secret = 'test-sentry-secret';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'intake-server.js')], {
    env: {
      ...process.env,
      CCP_ROOT: root,
      CCP_INTAKE_PORT: String(port),
      CCP_INTAKE_MAX_BODY_BYTES: '1024',
      CCP_HERMES_BIN: fakeHermes,
      SENTRY_CLIENT_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`intake server startup timeout: ${stderr}`)), 5_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`\"port\": ${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`intake server exited ${code}: ${stderr}`));
      });
    });
    await run(port, marker);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('signed Sentry issue events missing data.issue return 422 without task creation', async () => {
  await withIntakeServer(async (port, marker) => {
    const rawBody = Buffer.from(JSON.stringify({ action: 'created', data: {} }));
    const signature = crypto.createHmac('sha256', 'test-sentry-secret').update(rawBody).digest('hex');
    const result = await post(port, rawBody, signature);
    assert.equal(result.status, 422);
    assert.equal(result.body.ok, false);
    assert.equal(fs.existsSync(marker), false);
  });
});

test('rejects oversized unauthenticated request bodies before signature verification', async () => {
  await withIntakeServer(async (port, marker) => {
    const rawBody = Buffer.from(JSON.stringify({ padding: 'x'.repeat(2_000) }));
    const result = await post(port, rawBody, '', false);
    assert.equal(result.status, 413);
    assert.equal(result.body.ok, false);
    assert.equal(fs.existsSync(marker), false);
  });
});