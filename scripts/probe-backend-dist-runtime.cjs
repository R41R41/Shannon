'use strict';
// Offline composition smoke: catches stale compiled tools and startup-only registry failures.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = fs.realpathSync(path.join(__dirname, '..'));
async function main() {
  if (root !== '/home/azureuser/Shannon-dev' || !fs.existsSync(path.join(root, '.dev-runtime-lock')) || process.argv.length !== 2) {
    throw new Error('DEV_CHECKOUT_REQUIRED');
  }
  const oldUpdatePlan = path.join(root, 'backend/dist/services/llm/tools/updatePlan.js');
  if (fs.existsSync(oldUpdatePlan)) throw new Error('STALE_DIST_TOOL');
  process.chdir(path.join(root, 'backend'));
  const module = await import(pathToFileURL(path.join(root, 'backend/dist/services/llm/graph/nodeFactory.js')).href);
  const nodes = await module.initializeNodes();
  const names = nodes.fca.getToolNames();
  if (!names.length || new Set(names).size !== names.length || !names.includes('update-plan')) throw new Error('DIST_RUNTIME_INVALID');
  const perRun = nodes.fca.createToolsForRun();
  if (perRun.length !== names.length || !perRun.some(tool => tool.name === 'update-plan')) throw new Error('DIST_RUNTIME_INVALID');
  console.log(JSON.stringify({ initialized: true, tools: names.length, unique: true, staleOutputs: false }));
  process.exit(0);
}
main().catch(error => { console.error(error.message ?? 'DIST_RUNTIME_FAILED'); process.exit(1); });
