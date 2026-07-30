import assert = require('assert');
import http = require('http');
import path = require('path');
import { spawn } from 'child_process';

async function waitForHealth(port: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              assert.strictEqual(res.statusCode, 200);
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
              reject(error);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(500, () => req.destroy(new Error('health request timed out')));
      });
    } catch (error) {
      lastError = error as Error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('intake server did not become healthy');
}

async function main(): Promise<void> {
  const port = 14319;
  const entrypoint = path.join(__dirname, '..', 'bin', 'intake-server.js');
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, CCP_INTAKE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const health = await waitForHealth(port);
    assert.ok('launchd' in health, 'health response should contain launchd status');
    console.log('intake server load test passed');
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${stderr}`.trim());
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000)),
    ]);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
