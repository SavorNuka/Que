/**
 * Types shared by main, preload and renderer.
 * No Node or Electron imports may ever appear in this directory.
 */

export type MediaKind = 'video' | 'audio';

export type GroupType =
  | 'artist'
  | 'album'
  | 'series'
  | 'season'
  | 'saga'
  | 'collection'
  | 'custom';

export type ProviderId = 'cinemeta' | 'tmdb' | 'musicbrainz' | 'itunes' | 'manual';

export type ThumbSource = 'tmdb' | 'caa' | 'itunes' | 'embedded' | 'frame' | 'user';

export interface Source {
  id: number;
  kind: MediaKind;
  path: string;
  enabled: boolean;
  lastScanAt: number | null;
}

export interface MediaSummary {
  id: number;
  kind: MediaKind;
  title: string;
  sortTitle: string | null;
  year: number | null;
  durationMs: number | null;
  userRating: number | null;
  thumbPath: string | null;
  playCount: number;
  lastPlayedAt: number | null;
  resumeMs: number | null;
  missing: boolean;
  /** §23 */
  hidden: boolean;
  ageMin: number | null;
  explicit: boolean;
}

export interface AudioMeta {
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  trackNo: number | null;
  discNo: number | null;
  genre: string | null;
  mbRecordingId: string | null;
  mbReleaseId: string | null;
  mbReleaseGroupId: string | null;
}

export interface VideoMeta {
  tagline: string | null;
  runtimeMin: number | null;
  contentRating: string | null;
  backdropPath: string | null;
  tmdbId: number | null;
  isEpisode: boolean;
  season: number | null;
  episode: number | null;
  seriesTitle: string | null;
}

export interface MediaDetail extends MediaSummary {
  path: string;
  fileName: string;
  ext: string;
  sizeBytes: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  needsRemux: boolean;
  overview: string | null;
  genres: string[];
  trailerYtId: string | null;
  thumbSource: ThumbSource | null;
  provider: ProviderId | null;
  providerId: string | null;
  imdbId: string | null;
  addedAt: number;
  fields: Record<string, string>;
  audio: AudioMeta | null;
  video: VideoMeta | null;
}

/** §18 — the only shape that generates a library WHERE clause. */
export interface FilterSpec {
  q?: string;
  kind?: MediaKind;
  genres?: string[];
  years?: [number, number];
  rating?: { min?: number; max?: number; unrated?: boolean };
  artists?: string[];
  albums?: string[];
  series?: string[];
  playlistId?: number;
  groupId?: number;
  groupType?: GroupType;
  inAnyGroup?: boolean;
  watched?: 'yes' | 'no' | 'in-progress';
  hasSubs?: boolean;
  hasLyrics?: boolean;
  hasArtwork?: boolean;
  codecs?: string[];
  containers?: string[];
  needsRemux?: boolean;
  duration?: [number, number];
  addedWithin?: string;
  missing?: boolean;
  fields?: { key: string; op: 'eq' | 'contains' | 'exists'; value?: string }[];
  match: 'all' | 'any';
}

export type SortKey =
  | 'title'
  | 'year'
  | 'rating'
  | 'added'
  | 'played'
  | 'playCount'
  | 'duration'
  | 'artist'
  | 'album';

export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
  total: number | null;
}

/** §12.4 */
export interface GroupScreen {
  displayName?: string;
  tagline?: string;
  description?: string;
  hero?: {
    image?: string;
    focal?: 'center' | 'top' | 'bottom';
    overlay?: number;
    blur?: number;
    height?: 'compact' | 'standard' | 'full';
  };
  poster?: string;
  logo?: string;
  backdrop?: string;
  accent?: string;
  layout: 'poster-wall' | 'shelf' | 'list' | 'grid' | 'timeline';
  sortBy: 'position' | 'title' | 'year' | 'rating' | 'added' | 'track' | 'episode';
  sections: ('hero' | 'summary' | 'children' | 'items' | 'cast' | 'fields' | 'stats')[];
  showFields?: string[];
  skin?: string;
}

export interface GroupSummary {
  id: number;
  type: GroupType;
  kind: MediaKind;
  parentId: number | null;
  /** COALESCE(display_name, name) — the only string the UI should render. */
  label: string;
  name: string;
  displayName: string | null;
  year: number | null;
  favorite: boolean;
  origin: 'derived' | 'manual' | 'smart';
  itemCount: number;
  userRating: number | null;
}

export interface GroupDetail extends GroupSummary {
  screen: GroupScreen;
  providerId: string | null;
  provider: string | null;
  children: GroupSummary[];
  fields: Record<string, string>;
}

/** §23 — hiding and age limits. Enforced in the query builder, not the UI. */
export interface RestrictionSettings {
  /** Master switch. Off means everything below is inert. */
  enabled: boolean;
  /** Highest age allowed through. 13 shows G/PG/PG-13 and blocks R. */
  maxAge: number;
  /** What to do with items that carry no rating at all. */
  allowUnrated: boolean;
  /** Block tracks flagged explicit regardless of age rating. */
  blockExplicit: boolean;
  /** Whether unlocking requires a PIN. The PIN itself never crosses IPC. */
  pinSet: boolean;
  /** Minutes an unlock lasts before it re-locks itself. */
  unlockMinutes: number;
}

export interface RestrictionState extends RestrictionSettings {
  unlocked: boolean;
}

export interface Settings {
  preferredSubtitleLanguage: string;
  preferredLyricsLanguage: string;
  autoFetchMetadata: boolean;
  groupedBrowseVideo: boolean;
  groupedBrowseAudio: boolean;
  activeSkin: string;
  theme: 'system' | 'light' | 'dark';
  server: { enabled: boolean; port: number; lanEnabled: boolean };
  /** Presence only — values never leave the main process. */
  hasTmdbKey: boolean;
  hasWyzieKey: boolean;
}

export interface ProviderStatus {
  capability:
    | 'movie-metadata'
    | 'movie-artwork'
    | 'movie-trailers'
    | 'subtitles'
    | 'music-metadata'
    | 'music-artwork'
    | 'lyrics';
  active: string;
  chain: string[];
  upgradeHint: string | null;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  sqlite: string;
  dbPath: string;
  userDataPath: string;
  ffmpegAvailable: boolean;
}
