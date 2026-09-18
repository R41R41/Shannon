export type ArtifactKind = 'travel_brief';

export type ArtifactFileRole = 'html' | 'pdf' | 'preview';

export interface ArtifactFileRecord {
  role: ArtifactFileRole;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  id: string;
  kind: ArtifactKind;
  title: string;
  createdAt: string;
  expiresAt: string;
  files: ArtifactFileRecord[];
}

export interface ResolvedArtifactFile extends ArtifactFileRecord {
  absolutePath: string;
}

export interface ResolvedArtifactBundle {
  manifest: ArtifactManifest;
  files: ResolvedArtifactFile[];
}

export interface TripBriefSource {
  label: string;
  url: string;
  note?: string;
}

export interface TripBriefStop {
  time: string;
  title: string;
  description: string;
  place?: string;
  travel?: string;
  cost?: string;
  reservation?: string;
}

export interface TripBrief {
  title: string;
  subtitle?: string;
  date: string;
  introduction: string;
  participants?: string;
  meetingPoint?: string;
  weatherNote?: string;
  routeMap?: {
    encodedPolyline: string;
    caption?: string;
  };
  /** Server-generated data URI; never accepted directly from an LLM tool call. */
  routeMapImageDataUri?: string;
  stops: TripBriefStop[];
  highlights?: string[];
  rainPlan?: string[];
  notes?: string[];
  sources: TripBriefSource[];
}
