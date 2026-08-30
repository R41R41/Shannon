'use strict';
const path = require('node:path');
async function main() {
  const root = path.resolve(__dirname, '..');
  const { build } = await import('vite');
  await build({ configFile: false, envDir: false, root: path.join(root, 'frontend/radar'),
    resolve: { alias: { '@styles': path.join(root, 'frontend/src/styles') } }, esbuild: { jsx: 'automatic' },
    build: { outDir: path.join(root, 'frontend/dist-radar'), emptyOutDir: false }, logLevel: 'warn' });
}
main().catch(() => { console.error('RADAR_SITE_BUILD_FAILED'); process.exitCode = 1; });
