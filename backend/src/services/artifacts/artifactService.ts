import { ArtifactRenderer } from './artifactRenderer.js';
import { ArtifactStore, getArtifactStore } from './artifactStore.js';
import { renderTravelBriefHtml } from './travelBriefTemplate.js';
import type { ArtifactManifest, TripBrief } from './types.js';
import { renderStaticRouteMap } from '../maps/googleMapsService.js';
import { logger } from '../../utils/logger.js';

export class ArtifactService {
  constructor(
    private readonly store: ArtifactStore = getArtifactStore(),
    private readonly renderer: ArtifactRenderer = new ArtifactRenderer(),
  ) {}

  async createTravelBrief(brief: TripBrief): Promise<ArtifactManifest> {
    const draft = await this.store.createDraft();
    try {
      let routeMapImageDataUri: string | undefined;
      if (brief.routeMap?.encodedPolyline) {
        try {
          routeMapImageDataUri = await renderStaticRouteMap(brief.routeMap.encodedPolyline);
        } catch (error) {
          // Map is an enhancement; a route API or billing failure must not discard the PDF.
          logger.warn(`[ArtifactService] Route map omitted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const html = renderTravelBriefHtml({ ...brief, routeMapImageDataUri });
      const rendered = await this.renderer.renderHtmlPdfAndPreview(draft.directory, html);
      return await this.store.complete(draft, {
        kind: 'travel_brief',
        title: brief.title,
        files: [
          { role: 'preview', fileName: rendered.previewFileName, mediaType: 'image/jpeg' },
          { role: 'pdf', fileName: rendered.pdfFileName, mediaType: 'application/pdf' },
        ],
      });
    } catch (error) {
      await this.store.discard(draft);
      throw error;
    }
  }
}
