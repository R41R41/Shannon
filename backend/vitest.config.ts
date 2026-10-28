import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The body keeps its life numbers and its record of operations in files (continue contracts, 5 and 8): the unit tests keep them in a directory of their own, never in the
// working directory. (Set here and not in a setup file: a changed setup file belongs to every test's module graph, so `vitest related` would select the whole suite.)
const directory = mkdtempSync(path.join(tmpdir(), 'minebot-test-'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    env: {
      MINEBOT_LIFE_FILE: process.env.MINEBOT_LIFE_FILE ?? path.join(directory, 'life.json'),
      MINEBOT_OPLOG_DIR: process.env.MINEBOT_OPLOG_DIR ?? path.join(directory, 'oplog'),
    },
  },
});
