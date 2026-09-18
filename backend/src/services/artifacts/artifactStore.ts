import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArtifactFileRecord,
  ArtifactKind,
  ArtifactManifest,
  ResolvedArtifactBundle,
} from './types.js';

const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROOT_DIRECTORY = fileURLToPath(new URL('../../../saves/artifacts', import.meta.url));

export interface ArtifactDraft {
  id: string;
  directory: string;
}

export class ArtifactStore {
  private readonly rootDirectory: string;
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;

  constructor(options: {
    rootDirectory?: string;
    ttlMs?: number;
    maxFileBytes?: number;
  } = {}) {
    this.rootDirectory = resolve(
      options.rootDirectory
        ?? process.env.SHANNON_ARTIFACT_DIR
        ?? DEFAULT_ROOT_DIRECTORY,
    );
    this.ttlMs = options.ttlMs
      ?? (Number(process.env.SHANNON_ARTIFACT_TTL_MS) || DEFAULT_TTL_MS);
    this.maxFileBytes = options.maxFileBytes
      ?? (Number(process.env.SHANNON_ARTIFACT_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES);
  }

  async createDraft(): Promise<ArtifactDraft> {
    await this.cleanupExpired();
    const id = randomUUID();
    const directory = this.resolveArtifactDirectory(id);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    return { id, directory };
  }

  async complete(
    draft: ArtifactDraft,
    input: { kind: ArtifactKind; title: string; files: Omit<ArtifactFileRecord, 'sizeBytes'>[] },
  ): Promise<ArtifactManifest> {
    const expectedDirectory = this.resolveArtifactDirectory(draft.id);
    if (resolve(draft.directory) !== expectedDirectory) {
      throw new Error('Artifact draft directory does not belong to this store');
    }

    const files: ArtifactFileRecord[] = [];
    for (const file of input.files) {
      this.assertSafeFileName(file.fileName);
      const filePath = this.resolveOwnedPath(expectedDirectory, file.fileName);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw new Error(`Artifact output is not a file: ${file.fileName}`);
      if (fileStats.size <= 0) throw new Error(`Artifact output is empty: ${file.fileName}`);
      if (fileStats.size > this.maxFileBytes) {
        throw new Error(`Artifact output exceeds ${this.maxFileBytes} bytes: ${file.fileName}`);
      }
      files.push({ ...file, sizeBytes: fileStats.size });
    }

    const now = new Date();
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      id: draft.id,
      kind: input.kind,
      title: input.title,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      files,
    };
    await writeFile(
      this.resolveOwnedPath(expectedDirectory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    return manifest;
  }

  async resolveBundle(id: string): Promise<ResolvedArtifactBundle> {
    const directory = this.resolveArtifactDirectory(id);
    const raw = await readFile(this.resolveOwnedPath(directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as ArtifactManifest;
    if (manifest.schemaVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.files)) {
      throw new Error(`Invalid artifact manifest: ${id}`);
    }
    if (Date.parse(manifest.expiresAt) <= Date.now()) {
      throw new Error(`Artifact has expired: ${id}`);
    }

    const files = await Promise.all(manifest.files.map(async (file) => {
      this.assertSafeFileName(file.fileName);
      const absolutePath = this.resolveOwnedPath(directory, file.fileName);
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile() || fileStats.size !== file.sizeBytes) {
        throw new Error(`Artifact file failed integrity check: ${file.fileName}`);
      }
      return { ...file, absolutePath };
    }));
    return { manifest, files };
  }

  async discard(draft: ArtifactDraft): Promise<void> {
    const expectedDirectory = this.resolveArtifactDirectory(draft.id);
    if (resolve(draft.directory) !== expectedDirectory) return;
    await rm(expectedDirectory, { recursive: true, force: true });
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
      try {
        const directory = this.resolveArtifactDirectory(entry.name);
        const raw = await readFile(this.resolveOwnedPath(directory, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw) as ArtifactManifest;
        if (Date.parse(manifest.expiresAt) > now) continue;
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Incomplete drafts are cleaned only after they are older than the TTL.
        const directory = this.resolveArtifactDirectory(entry.name);
        const directoryStats = await stat(directory);
        if (directoryStats.mtimeMs + this.ttlMs <= now) {
          await rm(directory, { recursive: true, force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  private resolveArtifactDirectory(id: string): string {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new Error('Invalid artifact ID');
    return this.resolveOwnedPath(this.rootDirectory, id);
  }

  private resolveOwnedPath(parent: string, child: string): string {
    const resolvedParent = resolve(parent);
    const candidate = resolve(resolvedParent, child);
    if (candidate !== resolvedParent && !candidate.startsWith(`${resolvedParent}${sep}`)) {
      throw new Error('Artifact path escapes its owned directory');
    }
    return candidate;
  }

  private assertSafeFileName(fileName: string): void {
    if (!fileName || basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
      throw new Error(`Unsafe artifact file name: ${fileName}`);
    }
  }
}

let artifactStore: ArtifactStore | null = null;

export function getArtifactStore(): ArtifactStore {
  if (!artifactStore) artifactStore = new ArtifactStore();
  return artifactStore;
}

export function setArtifactStoreForTests(store: ArtifactStore | null): void {
  artifactStore = store;
}
