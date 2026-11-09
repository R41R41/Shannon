// Apply the repository's complete Mineflayer patch, including item rotation, to private dependency inodes.
// The lab links dependencies from a shared tree: never patch those hard links in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [stage, patchFile] = process.argv.slice(2);
const root = fs.realpathSync(stage);
const labHome = fs.realpathSync('/home/azureuser');
const privateLab = path.dirname(root) === labHome && /^Shannon-(?:hunt|end)-lab-[A-Za-z0-9._-]{1,40}$/.test(path.basename(root));
if (!privateLab
  && !['/home/ghrunner/codex-combat-check', '/home/ghrunner/codex-end-check'].includes(root)) throw new Error('PRIVATE_LAB_STAGE_REQUIRED');
const dependency = path.join(root, 'node_modules/mineflayer');
const packageJson = JSON.parse(fs.readFileSync(path.join(dependency, 'package.json'), 'utf8'));
if (packageJson.version !== '4.35.0') throw new Error('MINEFLAYER_VERSION_MISMATCH');
const patch = fs.readFileSync(patchFile, 'utf8').replaceAll('\r\n', '\n');
const prepared = [];
for (const name of ['entities.js', 'inventory.js']) {
  const target = path.join(dependency, 'lib/plugins', name);
  if (fs.realpathSync(target) !== target) throw new Error('PRIVATE_REGULAR_DEPENDENCY_FILE_REQUIRED');
  const section = patch.split(/^diff --git /m).find(text => text.startsWith(`a/node_modules/mineflayer/lib/plugins/${name} `));
  if (!section) throw new Error(`REPOSITORY_PATCH_REQUIRED:${name}`);
  const hunks = section.split(/^@@[^\n]*\n/m).slice(1);
  if (!hunks.length) throw new Error(`PATCH_HUNKS_REQUIRED:${name}`);
  const original = fs.readFileSync(target, 'utf8');
  let updated = original.replaceAll('\r\n', '\n');
  for (const hunk of hunks) {
    const lines = hunk.split('\n').filter(line => /^[ +\-]/.test(line));
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n');
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n');
    const matches = text => updated.split(text).length - 1;
    if (matches(after) === 1 && matches(before) === 0) continue;
    if (!before || matches(before) !== 1) throw new Error(`PATCH_CONTEXT_MISMATCH:${name}`);
    updated = updated.replace(before, after);
  }
  prepared.push({ target, original, updated });
}
// Validate every context before mutating any private file. rename breaks the shared hard link.
for (const { target, original, updated } of prepared) {
  if (updated !== original) {
    const temporary = `${target}.codex-${process.pid}`;
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: fs.statSync(target).mode });
    try { fs.renameSync(temporary, target); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  console.log(`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}  ${path.relative(root, target)}`);
}
console.log(`${crypto.createHash('sha256').update(patch).digest('hex')}  repository-mineflayer-patch`);
