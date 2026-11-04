// Check only changed TS roots, including the ENTIRE probe; do not execute the live script.
const ts = require('typescript');
const path = require('node:path');
const configPath = path.join(__dirname, 'tsconfig.end-knock.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, __dirname);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...parsed.fileNames.flatMap(p => {
  const source = program.getSourceFile(p);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
})];
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
}));
console.log(`end knock: ${parsed.fileNames.length} changed TS roots (entire probe included), ${diagnostics.length} diagnostics; dependency semantic diagnostics excluded`);
process.exitCode = diagnostics.length ? 1 : 0;
