import fs from 'node:fs';
import path from 'node:path';

/** Exclusive lock file with a bounded synchronous wait; never breaks another holder's lock. */
export function acquireExclusiveFileLock(lockFile: string, timeoutMs = 10_000): number {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return fs.openSync(lockFile, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}

/** Replace a file's content durably: write a private temporary, fsync, rename, fsync the directory. */
export function writeFileAtomically(file: string, content: string): void {
  const temporary = `${file}.pending-${process.pid}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
