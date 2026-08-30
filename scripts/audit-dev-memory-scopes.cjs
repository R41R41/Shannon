'use strict';

// Explicit dev-only native driver scan: no application bootstrap, dotenv, models, indexes or writes.
const fs = require('node:fs');
const path = require('node:path');
const { auditMemoryMetadata } = require('./lib/memory-scope-audit.cjs');

function validateInvocation(args, root, locked) {
  if (args.length !== 1 || args[0] !== '--dev-read-only') throw new Error('EXPLICIT_DEV_READ_ONLY_FLAG_REQUIRED');
  if (root !== '/home/azureuser/Shannon-dev' || !locked) throw new Error('LOCKED_VM_DEV_REQUIRED');
}
async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  validateInvocation(process.argv.slice(2), root, fs.existsSync(path.join(root, '.dev-runtime-lock')));
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient('mongodb://127.0.0.1:27017/shannon_dev', { serverSelectionTimeoutMS: 5000, appName: 'shannon-dev-memory-inventory' });
  try {
    await client.connect();
    const report = await auditMemoryMetadata(client.db('shannon_dev'));
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), database: 'shannon_dev', ...report }, null, 2));
  } finally { await client.close(); }
}
if (require.main === module) main().catch(() => {
  // Errors may contain credentials/connection details. Keep the public failure generic.
  console.error('DEV_MEMORY_AUDIT_FAILED: no migration was attempted'); process.exitCode = 1;
});
module.exports = { validateInvocation };
