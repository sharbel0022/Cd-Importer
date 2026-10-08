export type MusicSource = "archive" | "commons";

/** Only source identifiers cross the trust boundary, never client-provided URLs. */
export interface TrackRef {
  source: MusicSource;
  id: string;
  file?: string;
}

export interface MusicLicense {
  name: string;
  url?: string;
  downloadAllowed: boolean;
  conversionAllowed: boolean;
  attribution?: string;
  reason: string;
}

export interface Track extends TrackRef {
  key: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  duration?: number;
  format: string;
  sourceUrl: string;
  license: MusicLicense;
  playbackAllowed: boolean;
  downloadAllowed: boolean;
  size?: number;
}

export interface SearchResponse {
  tracks: Track[];
  warnings: string[];
  page: number;
  hasMore: boolean;
}

export type Bitrate = 128 | 192 | 256 | 320;

export function trackQuery(track: TrackRef): string {
  const params = new URLSearchParams({ source: track.source, id: track.id });
  if (track.file) params.set("file", track.file);
  return params.toString();
}

export function trackRef(track: TrackRef): TrackRef {
  return { source: track.source, id: track.id, ...(track.file ? { file: track.file } : {}) };
}
