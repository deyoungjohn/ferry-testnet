import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SolverDatabase } from '../src/db/database.js';

describe('database unit guard', () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix);
      }
    }
  });
  const tmp = () => {
    const p = path.join(
      process.cwd(),
      `test-unitguard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    paths.push(p);
    return p;
  };

  it('rewrites millisecond rows written after the v3 migration, and leaves seconds and first_seen_at alone', () => {
    const file = tmp();
    const first = new SolverDatabase(file);
    first.db
      .prepare(
        `INSERT INTO orders (id, direction, status, user_counter_address, lock_id, terms_json, hash_lock, needs_attention, created_at, updated_at, first_seen_at)
         VALUES ('ms', 'BCH_TO_COUNTER', 'EXPIRED', '0xa', 'l1', '{}', '0x01', 0, 1793208015079, 1793208461670, 1793208039987),
                ('s',  'BCH_TO_COUNTER', 'DONE',    '0xb', 'l2', '{}', '0x02', 0, 1793200813, 1793200872, NULL)`,
      )
      .run();
    first.close();

    const reopened = new SolverDatabase(file);
    const ms = reopened.db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get('ms') as Record<string, number>;
    const sec = reopened.db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get('s') as Record<string, number>;
    expect(ms.created_at).toBe(1793208015);
    expect(ms.updated_at).toBe(1793208461);
    expect(ms.first_seen_at).toBe(1793208039987);
    expect(sec.created_at).toBe(1793200813);
    expect(reopened.normalizeTimestampUnits()).toBe(0);
    reopened.close();
  });

  it('refuses a database newer than the code supports', () => {
    const file = tmp();
    const first = new SolverDatabase(file);
    first.close();
    const raw = new Database(file);
    raw.pragma('user_version = 4');
    raw.close();
    expect(() => new SolverDatabase(file)).toThrow(/newer than this solver/);
  });
});
