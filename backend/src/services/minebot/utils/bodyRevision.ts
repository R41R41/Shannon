import fs from 'node:fs';
import path from 'node:path';

/**
 * The git revision of the body being run (continue contracts, 8: the poll's `bodyVersion.revision`, which the head writes in the decision records and
 * compares with the revision a produced fixture was made from). In order: SHANNON_BODY_REV (a deploy that knows), a `REVISION` file beside the working
 * directory or the repository root, the `.git` HEAD of the nearest repository; else `unknown`. Read once.
 */
let cached: string | null = null;
export function bodyRevision(start: string = process.cwd()): string {
  if (cached !== null) return cached;
  cached = readRevision(start) ?? 'unknown';
  return cached;
}
export function readRevision(start: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = String(env.SHANNON_BODY_REV ?? '').trim();
  if (/^[0-9a-f]{7,40}$/iu.test(fromEnv)) return fromEnv.toLowerCase();
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth++) {
    try {
      const file = path.join(dir, 'REVISION');
      if (fs.existsSync(file)) { const text = fs.readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{7,40}$/iu.test(text)) return text.toLowerCase(); }
      const git = path.join(dir, '.git');
      if (fs.existsSync(git)) {
        const gitDir = fs.statSync(git).isDirectory() ? git : path.resolve(dir, fs.readFileSync(git, 'utf8').replace(/^gitdir:\s*/u, '').trim());
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (/^[0-9a-f]{40}$/iu.test(head)) return head.slice(0, 12).toLowerCase();
        const ref = /^ref:\s*(.+)$/u.exec(head)?.[1];
        if (ref) {
          const common = fs.existsSync(path.join(gitDir, 'commondir')) ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
          for (const root of [gitDir, common]) {
            try { const sha = fs.readFileSync(path.join(root, ref), 'utf8').trim(); if (/^[0-9a-f]{40}$/iu.test(sha)) return sha.slice(0, 12).toLowerCase(); } catch { /* try the next */ }
          }
          try {
            const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/u).find(line => line.endsWith(` ${ref}`));
            const sha = packed?.split(' ')[0];
            if (sha && /^[0-9a-f]{40}$/iu.test(sha)) return sha.slice(0, 12).toLowerCase();
          } catch { /* none */ }
        }
        return null;
      }
    } catch { /* the next directory up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
