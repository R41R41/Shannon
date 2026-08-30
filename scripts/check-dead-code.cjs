// Deletion gate. Knip answers "is this file referenced"; eslint answers "was this
// declaration ever wired up". Neither judges whether code is worth keeping, so anything
// they find has to be deleted or written into deletion-ledger.json with a deadline.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ledgerPath = path.join(root, 'deletion-ledger.json');
const errors = [];
const notes = [];

function bin(name) {
  const local = path.join(root, 'node_modules', '.bin', name);
  return fs.existsSync(local) ? local : name;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) throw new Error(`${command} produced no output:\n${result.stderr}`);
  return result.stdout;
}

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const listed = new Map();
for (const entry of ledger.files) {
  if (!entry.path || !entry.reason || !entry.owner || !/^\d{4}-\d{2}-\d{2}$/.test(entry.sunset ?? '')) {
    errors.push(`deletion-ledger.json: 項目に path/reason/owner/sunset(YYYY-MM-DD) が揃っていない: ${JSON.stringify(entry)}`);
    continue;
  }
  if (listed.has(entry.path)) errors.push(`deletion-ledger.json: ${entry.path} が重複している`);
  listed.set(entry.path, entry);
}

const knip = JSON.parse(
  run(bin('knip'), ['--include', 'files,unresolved', '--reporter', 'json', '--no-progress', '--no-exit-code'], root),
);

// An import of a module that no longer exists is the other half of a half-finished deletion:
// the old file went away and its callers were left behind. Type-only imports survive both
// `tsc --noCheck` and the tests, so nothing else in CI notices them.
for (const issue of knip.issues) {
  for (const ref of issue.unresolved ?? []) {
    errors.push(`存在しないモジュールを import している: ${issue.file}:${ref.line} → ${ref.name}`);
  }
}

const unused = new Set(knip.issues.filter(issue => issue.files?.length).map(issue => issue.file));

for (const file of [...unused].sort()) {
  if (listed.has(file)) continue;
  errors.push(`未参照のファイルが台帳にない: ${file}`);
}
for (const [file, entry] of [...listed].sort()) {
  if (!unused.has(file)) {
    errors.push(`台帳の項目がもう未参照ではない。削除済みなら台帳からも消す: ${file}`);
  } else if (entry.sunset < today) {
    errors.push(`期限切れ (${entry.sunset}, 担当 ${entry.owner}): ${file} — ${entry.reason}`);
  }
}

const lint = JSON.parse(run(bin('eslint'), ['--config', 'eslint.dead-code.mjs', 'src/**/*.ts', '-f', 'json'], path.join(root, 'backend')));
const unusedLocals = lint.reduce((total, file) => total + file.errorCount, 0);
const baseline = ledger.unusedLocals.baseline;
if (unusedLocals > baseline) {
  errors.push(`未使用の宣言が ${baseline} 件から ${unusedLocals} 件に増えた。新しい分を消すか、残す理由を添えて baseline を上げる`);
} else if (unusedLocals < baseline) {
  errors.push(`未使用の宣言が ${unusedLocals} 件に減った。deletion-ledger.json の unusedLocals.baseline をこの数に下げる`);
} else {
  notes.push(`未使用の宣言 ${unusedLocals} 件 (baseline 通り)`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Deletion gate passed (未参照ファイル ${unused.size} 件はすべて台帳にあり期限内、${notes.join('、')})`);
}
