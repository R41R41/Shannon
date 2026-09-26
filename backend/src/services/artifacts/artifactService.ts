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
    private readonly renderRouteMap: (encodedPolyline: string) => Promise<string> = renderStaticRouteMap,
  ) {}

  async createTravelBrief(brief: TripBrief): Promise<ArtifactManifest> {
    const draft = await this.store.createDraft();
    try {
      let routeMapImageDataUri: string | undefined;
      if (brief.routeMap?.encodedPolyline) {
        try {
          routeMapImageDataUri = await this.renderRouteMap(brief.routeMap.encodedPolyline);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`[ArtifactService] Route map rendering failed: ${detail}`);
          throw new Error(`Route map rendering failed: ${detail}`);
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
