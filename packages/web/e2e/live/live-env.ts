import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = path.resolve(webRoot, '../..');
const envPath = path.join(repoRoot, '.env.local');

export const LIVE_SOLVER_URL =
  process.env.PLAYWRIGHT_LIVE_SOLVER_URL ?? 'http://127.0.0.1:8787';

export function liveEnv(key: string): string {
  const text = fs.readFileSync(envPath, 'utf8');
  const value = text
    .match(new RegExp(`^${key}=([^\\r\\n]+)$`, 'm'))?.[1]
    ?.trim();
  if (!value) throw new Error(`Missing ${key} in .env.local`);
  return value;
}

export async function liveSolverReady(
  request: APIRequestContext,
): Promise<boolean> {
  try {
    const response = await request.get(`${LIVE_SOLVER_URL}/v1/health`, {
      timeout: 5_000,
    });
    return response.ok();
  } catch {
    return false;
  }
}

export const LIVE_SKIP_REASON = `Live solver is not running at ${LIVE_SOLVER_URL}; start it with pnpm dev:solver and rerun.`;
