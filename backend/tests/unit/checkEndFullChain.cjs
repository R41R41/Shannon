// Check the changed TS files, including the live probe, without executing any of them.
const ts = require('typescript');
const path = require('node:path');
const configPath = path.join(__dirname, 'tsconfig.end-full-chain.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, __dirname);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const roots = new Set(parsed.fileNames.map(p => path.resolve(p).toLowerCase()));
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics().filter(d => d.file && roots.has(path.resolve(d.file.fileName).toLowerCase()))];
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
}));
console.log(`end_full_chain: ${parsed.fileNames.length} TS files (probe included), ${diagnostics.length} diagnostics; dependency semantic diagnostics excluded`);
process.exitCode = diagnostics.length ? 1 : 0;
