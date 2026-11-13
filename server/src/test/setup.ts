import { afterAll } from 'vitest';
import { closeDatabase } from '../db/admin.js';

// Runs in every test file: release the file's pg pool so the worker exits cleanly.
afterAll(async () => {
  await closeDatabase();
});
