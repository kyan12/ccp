import assert = require('node:assert/strict');
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http = require('node:http');
import net = require('node:net');
import test = require('node:test');
import { hmacSha256Hex } from './webhook-auth';

const secret = 'github-route-auth-test-secret';
const malformedBody = Buffer.from('{"action":');

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('failed to reserve TCP port'));
        return;
      }
      const selected = address.port;
      socket.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('intake server did not start')), 5_000);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString('utf8').includes('"ok": true')) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`intake server exited before startup (${code})`));
    });
  });
}

async function post(port: number, signature?: string, requestBody = malformedBody): Promise<{ status: number; body: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/webhook/github',
      headers: {
        'content-type': 'application/json',
        'content-length': requestBody.length,
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.end(requestBody);
  });
}

test('actual GitHub webhook route authenticates raw bytes before JSON parsing', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, [require.resolve('../bin/intake-server')], {
    env: {
      ...process.env,
      CCP_INTAKE_PORT: String(port),
      GITHUB_WEBHOOK_SECRET: secret,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);

    const unauthenticated = await post(port);
    assert.equal(unauthenticated.status, 403);
    assert.deepEqual(unauthenticated.body, { ok: false, error: 'bad GitHub signature' });

    const signed = await post(port, `sha256=${hmacSha256Hex(secret, malformedBody)}`);
    assert.equal(signed.status, 410);
    assert.equal(signed.body.action, 'retired');
    assert.equal(signed.body.retryable, false);
    assert.equal(signed.body.replacement, 'native-hermes-kanban');

    const oversizedBody = Buffer.alloc(1_048_577, 0x61);
    const oversized = await post(port, undefined, oversizedBody);
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error, 'request body too large');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }
});
