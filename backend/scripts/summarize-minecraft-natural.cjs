const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve('saves/minecraft/progressive_reports');
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
const files = process.argv.slice(2);
for (const file of files.length ? files : fs.readdirSync(directory).filter(name => /2026-09-29T16-.*(natural|openai)-acceptance\.json$/.test(name)).sort()) {
  const report = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  console.log(JSON.stringify({ file, real: report.real, sourceUnchanged: report.sourceUnchanged, requests: report.requests?.length,
    died: report.died, heights: report.site?.terrain?.distinctHeights, uphill: report.site?.uphill,
    cases: report.reports.map(run => ({ scenario: run.scenario, error: run.infrastructureError, passed: run.passed, totalMs: run.durationMs,
      agentMs: run.executor?.durationMs, turns: run.executor?.iterations, minHealth: run.minHealth,
      physicalMs: run.executor?.cognitiveWorkspace?.receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0),
      receipts: run.executor?.cognitiveWorkspace?.receipts.map(receipt => ({ skill: receipt.capability, durationMs: receipt.durationMs, success: receipt.success, result: receipt.resultSummary })),
      errors: run.toolTrace?.filter(tool => tool.success === false),
      nodes: flatten(run.executor?.taskNodes ?? []).map(node => ({ id: node.id, status: node.status, proof: node.verification?.status })),
    })) }));
}
