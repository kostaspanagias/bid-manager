import { afterAll } from 'vitest';
import { closePool } from '../db/pool.js';

// Runs in every test file: release the file's pg pool so the worker exits cleanly.
afterAll(async () => {
  await closePool();
});
