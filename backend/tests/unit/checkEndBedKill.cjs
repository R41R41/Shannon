// Type-check the changed roots, including the entire live probe, without executing it.
const ts = require('typescript');
const path = require('node:path');
const configPath = path.join(__dirname, 'tsconfig.end-bed-kill.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, __dirname);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const roots = new Set(parsed.fileNames.map(p => path.resolve(p).toLowerCase()));
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...parsed.fileNames.flatMap(p => {
  const source = program.getSourceFile(p);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
})];
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
}));
console.log(`end_bed_kill: ${roots.size} TS roots (entire probe included), ${diagnostics.length} diagnostics; dependency semantic diagnostics excluded`);
process.exitCode = diagnostics.length ? 1 : 0;
