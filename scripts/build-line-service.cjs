'use strict';
// Pure build: no secrets, database, provider access or service startup.
const fs = require('node:fs'), path = require('node:path');
const { build } = require('esbuild');
const root = path.resolve(__dirname,'..');
async function main() {
  if (root !== '/home/azureuser/Shannon-dev' || !fs.existsSync(path.join(root,'.dev-runtime-lock')) || process.argv.length !== 2) throw Error();
  const out = path.join(root,'backend/dist-line'); fs.mkdirSync(out,{recursive:true});
  const result = await build({ absWorkingDir: root, entryPoints: ['backend/src/services/line/runtime.ts'], outfile: path.join(out,'runtime.mjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', metafile: true });
  const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(o => o.imports.filter(i => i.external).map(i => i.path)))];
  const allowed = ['express','cheerio','@langchain/openai','@langchain/core/messages'];
  if (imports.some(i => !i.startsWith('node:') && !allowed.includes(i))) throw Error('UNEXPECTED_EXTERNAL_IMPORT');
  const dependencies = Object.fromEntries(['express','mongoose','cheerio','dotenv','@langchain/openai','@langchain/core'].map(name =>
    [name,JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version]));
  fs.writeFileSync(path.join(out,'package.json'),JSON.stringify({name:'shannon-line-runtime',version:'1.0.0',private:true,type:'module',engines:{node:'22.x'},dependencies},null,2)+'\n');
  fs.writeFileSync(path.join(out,'build-manifest.json'),JSON.stringify({inputs:Object.keys(result.metafile.inputs),imports},null,2)+'\n');
  console.log(JSON.stringify({built:true,inputs:Object.keys(result.metafile.inputs).length,imports}));
}
main().catch(e => { console.error(e.message === 'UNEXPECTED_EXTERNAL_IMPORT' ? e.message : 'LINE_BUILD_FAILED'); process.exitCode=1; });
