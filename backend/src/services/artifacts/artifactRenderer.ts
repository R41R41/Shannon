import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ArtifactCommandRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<void>;

const defaultCommandRunner: ArtifactCommandRunner = async (executable, args, timeoutMs) => {
  await new Promise<void>((resolve, reject) => {
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = stderr?.trim() || error.message;
      reject(new Error(`${executable} failed: ${detail}`));
    });
  });
};

export interface RenderedArtifactFiles {
  htmlFileName: string;
  pdfFileName: string;
  previewFileName: string;
}

export class ArtifactRenderer {
  constructor(
    private readonly runCommand: ArtifactCommandRunner = defaultCommandRunner,
    private readonly binaries = {
      pdf: process.env.WKHTMLTOPDF_PATH || 'wkhtmltopdf',
      image: process.env.WKHTMLTOIMAGE_PATH || 'wkhtmltoimage',
    },
  ) {}

  async renderHtmlPdfAndPreview(directory: string, html: string): Promise<RenderedArtifactFiles> {
    const htmlFileName = 'shannon-trip-guide.html';
    const pdfFileName = 'shannon-trip-guide.pdf';
    const previewFileName = 'shannon-trip-preview.jpg';
    const htmlPath = join(directory, htmlFileName);
    const pdfPath = join(directory, pdfFileName);
    const previewPath = join(directory, previewFileName);

    await writeFile(htmlPath, html, { encoding: 'utf8', mode: 0o600 });

    await Promise.all([
      this.runCommand(this.binaries.pdf, [
        '--quiet',
        '--encoding', 'utf-8',
        '--disable-javascript',
        '--disable-local-file-access',
        '--page-size', 'A4',
        '--margin-top', '10mm',
        '--margin-right', '8mm',
        '--margin-bottom', '10mm',
        '--margin-left', '8mm',
        htmlPath,
        pdfPath,
      ], 30_000),
      this.runCommand(this.binaries.image, [
        '--quiet',
        '--encoding', 'utf-8',
        '--disable-javascript',
        '--disable-local-file-access',
        '--format', 'jpg',
        '--quality', '82',
        '--width', '960',
        htmlPath,
        previewPath,
      ], 30_000),
    ]);

    await Promise.all([access(pdfPath), access(previewPath)]);
    return { htmlFileName, pdfFileName, previewFileName };
  }
}
