// Runs before every test file (vitest setupFiles).
//
// An EPISODIC_MEMORY_DB_PATH inherited from the dev shell would point tests
// at a real database (#14). getDbPath() prefers TEST_DB_PATH, but not every
// test sets one — strip the inherited value so no test can fall through to
// it. Tests that exercise the production override (test/integration.test.ts)
// set it explicitly after this runs.
if (process.env.EPISODIC_MEMORY_DB_PATH !== undefined) {
  console.warn(
    '[test/setup.ts] Ignoring inherited EPISODIC_MEMORY_DB_PATH ' +
      `(${process.env.EPISODIC_MEMORY_DB_PATH}) — tests must not touch a real database.`
  );
  delete process.env.EPISODIC_MEMORY_DB_PATH;
}
