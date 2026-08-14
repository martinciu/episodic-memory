// Regression test for #14: EPISODIC_MEMORY_DB_PATH must not override
// TEST_DB_PATH. A dev shell exporting the former would otherwise point every
// TEST_DB_PATH-isolated test at the real database — including the DELETEs in
// test/prune.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDbPath } from '../src/paths.js';

describe('getDbPath env overrides', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.EPISODIC_MEMORY_DB_PATH = process.env.EPISODIC_MEMORY_DB_PATH;
    saved.TEST_DB_PATH = process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    delete process.env.TEST_DB_PATH;
  });

  afterEach(() => {
    for (const key of ['EPISODIC_MEMORY_DB_PATH', 'TEST_DB_PATH'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('prefers TEST_DB_PATH when both overrides are set', () => {
    process.env.EPISODIC_MEMORY_DB_PATH = '/real/production/db.sqlite';
    process.env.TEST_DB_PATH = '/tmp/isolated/test.db';

    expect(getDbPath()).toBe('/tmp/isolated/test.db');
  });

  it('uses EPISODIC_MEMORY_DB_PATH when it is the only override', () => {
    process.env.EPISODIC_MEMORY_DB_PATH = '/custom/location/db.sqlite';

    expect(getDbPath()).toBe('/custom/location/db.sqlite');
  });

  it('uses TEST_DB_PATH when it is the only override', () => {
    process.env.TEST_DB_PATH = '/tmp/isolated/test.db';

    expect(getDbPath()).toBe('/tmp/isolated/test.db');
  });
});
