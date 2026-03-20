import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * @shannon/backend パッケージのルート（package.json / saves / src があるディレクトリ）。
 * process.cwd() に依存せず、コンパイル後も dist から正しく解決する。
 */
export function getBackendRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..');
}
