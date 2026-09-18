import { ArtifactRenderer } from './artifactRenderer.js';
import { ArtifactStore, getArtifactStore } from './artifactStore.js';
import { renderTravelBriefHtml } from './travelBriefTemplate.js';
import type { ArtifactManifest, TripBrief } from './types.js';

export class ArtifactService {
  constructor(
    private readonly store: ArtifactStore = getArtifactStore(),
    private readonly renderer: ArtifactRenderer = new ArtifactRenderer(),
  ) {}

  async createTravelBrief(brief: TripBrief): Promise<ArtifactManifest> {
    const draft = await this.store.createDraft();
    try {
      const html = renderTravelBriefHtml(brief);
      const rendered = await this.renderer.renderHtmlPdfAndPreview(draft.directory, html);
      return await this.store.complete(draft, {
        kind: 'travel_brief',
        title: brief.title,
        files: [
          { role: 'preview', fileName: rendered.previewFileName, mediaType: 'image/jpeg' },
          { role: 'pdf', fileName: rendered.pdfFileName, mediaType: 'application/pdf' },
          { role: 'html', fileName: rendered.htmlFileName, mediaType: 'text/html; charset=utf-8' },
        ],
      });
    } catch (error) {
      await this.store.discard(draft);
      throw error;
    }
  }
}
