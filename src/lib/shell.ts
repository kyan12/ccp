import { spawnSync } from 'child_process';
import type { RunResult } from '../types';

export function run(command: string, args: string[] = [], options: Record<string, unknown> = {}): RunResult {
  return spawnSync(command, args, { encoding: 'utf8', ...options }) as unknown as RunResult;
}

const _commandExistsCache = new Map<string, string>();
export function commandExists(cmd: string): string {
  if (_commandExistsCache.has(cmd)) return _commandExistsCache.get(cmd)!;
  const out = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  const result = out.status === 0 ? out.stdout.trim() : '';
  _commandExistsCache.set(cmd, result);
  return result;
}

export function parsePrUrl(prUrl: string | null | undefined): { ownerRepo: string; number: number } | null {
  const m = String(prUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { ownerRepo: m[1], number: Number(m[2]) };
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
