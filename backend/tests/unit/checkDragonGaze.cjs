// Check only the changed TS roots; do not execute runtime code or diagnose the dependency graph.
const ts = require('typescript');
const path = require('node:path');
const config = ts.readConfigFile(path.join(__dirname, 'tsconfig.dragon-gaze.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, __dirname);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics()];
for (const file of parsed.fileNames) {
  const source = program.getSourceFile(file);
  diagnostics.push(...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source));
}
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
}));
console.log(`dragon gaze: ${parsed.fileNames.length} changed TS files, ${diagnostics.length} diagnostics; dependency diagnostics excluded`);
process.exitCode = diagnostics.length ? 1 : 0;
