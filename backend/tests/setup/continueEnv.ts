import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The body keeps its life numbers and its record of operations in files (continue contracts, 5 and 8): the unit tests keep them in a directory of their own,
// never in the working directory.
const directory = mkdtempSync(path.join(tmpdir(), 'minebot-test-'));
process.env.MINEBOT_LIFE_FILE ??= path.join(directory, 'life.json');
process.env.MINEBOT_OPLOG_DIR ??= path.join(directory, 'oplog');
