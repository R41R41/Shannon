// Offline, explicit build step. Derived from Syzygy/scripts/minecraft-vision-bench/build-current.cjs.
// Never changes installed dependencies, connects a bot, or starts a viewer server.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const target = process.argv[2];
const destination = process.argv[3] && path.resolve(process.argv[3]);
const assetsPackage = process.argv[4];
if (!/^\d+\.\d+\.\d+$/.test(target || '') || !destination || !assetsPackage) {
  throw Error('Usage: node scripts/prepare-common-fca-renderer.cjs VERSION NEW_OUTPUT_DIR /path/to/minecraft-assets');
}
if (fs.existsSync(destination)) throw Error('Renderer output must be a new directory');
const source = path.dirname(require.resolve('prismarine-viewer/package.json'));
const sourceRequire = createRequire(path.join(source, 'package.json'));
const assets = require(path.resolve(assetsPackage))(target);
if (!assets || path.basename(assets.directory) !== target) throw Error('Matching exact-version Minecraft assets required');
const chunk = new (sourceRequire('prismarine-chunk')(target))();
const { makeTextureAtlas } = sourceRequire('./viewer/lib/atlas.js');
const { prepareBlocksStates } = sourceRequire('./viewer/lib/modelsBuilder.js');
const atlas = makeTextureAtlas(assets);
fs.mkdirSync(destination, { recursive: true });
for (const name of ['viewer', 'public', 'package.json', 'LICENSE']) {
  const file = path.join(source, name); if (fs.existsSync(file)) fs.cpSync(file, path.join(destination, name), { recursive: true });
}
// Resolve existing runtime libraries read-only; output stays a separate artifact.
let modules = path.dirname(source);
while (!fs.existsSync(path.join(modules, 'three')) && path.dirname(modules) !== modules) modules = path.dirname(modules);
fs.symlinkSync(modules, path.join(destination, 'node_modules'), 'dir');
const rewrite = (file, before, after) => {
  const name = path.join(destination, file), value = fs.readFileSync(name, 'utf8');
  if (!value.includes(before)) throw Error(`Viewer source changed: ${file}`);
  fs.writeFileSync(name, value.split(before).join(after));
};
rewrite('viewer/lib/version.js', 'const supportedVersions = [', `const supportedVersions = ['${target}', `);
rewrite('viewer/lib/worldrenderer.js', 'for (let y = 0; y < 256; y += 16)',
  `for (let y = ${chunk.minY}; y < ${chunk.minY + chunk.worldHeight}; y += 16)`);
rewrite('viewer/lib/worker.js', 'chunk.sections[Math.floor(y / 16)]', 'chunk.sections[Math.floor((y - chunk.minY) / 16)]');
fs.writeFileSync(path.join(destination, 'public/textures', `${target}.png`), atlas.canvas.toBuffer('image/png'));
fs.writeFileSync(path.join(destination, 'public/blocksStates', `${target}.json`), JSON.stringify(prepareBlocksStates(assets, atlas)));
fs.cpSync(assets.directory, path.join(destination, 'public/textures', target), { recursive: true });
fs.writeFileSync(path.join(destination, 'common-fca-renderer.json'), JSON.stringify({ target, minY: chunk.minY,
  worldHeight: chunk.worldHeight, viewerVersion: sourceRequire('./package.json').version }));
console.log(`Prepared exact-version renderer for ${target}`);
