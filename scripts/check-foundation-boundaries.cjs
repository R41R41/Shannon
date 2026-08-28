// Code-boundary check, not a runtime security sandbox. Never imports application code.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const moduleRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'backend/src/modules');
const allowed = { access: ['access'], modelSettings: ['access', 'modelSettings'], execution: ['execution'], memory: ['memory'] };
const errors = [];
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []); }
for (const [owner, dependencies] of Object.entries(allowed)) {
  const dir = path.join(moduleRoot, owner);
  if (!fs.existsSync(dir)) { errors.push(`Missing module: ${owner}`); continue; }
  for (const file of walk(dir)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const fail = message => errors.push(`${path.relative(moduleRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) { fail('Nonliteral module reference'); return; }
        const spec = node.moduleSpecifier.text;
        const resolved = ts.resolveModuleName(spec, file, { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext }, ts.sys).resolvedModule;
        const relative = resolved && path.relative(moduleRoot, resolved.resolvedFileName);
        if (!spec.startsWith('.') || !relative || !dependencies.includes(relative.split(path.sep)[0])) fail(`Forbidden dependency: ${spec}`);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) fail('Dynamic loading is not allowed in foundation modules');
      if (ts.isIdentifier(node) && ['process', 'fetch', 'setTimeout', 'setInterval', 'WebSocket'].includes(node.text)) fail(`Platform dependency: ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Foundation boundaries passed (access, modelSettings, execution, memory)');
