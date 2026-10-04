import type {
  Album,
  Folder,
  LibraryStats,
  LibraryView,
  MediaDetail,
  MediaItem,
  MediaPage,
  Person,
  Place,
  FamilySuggestion,
  RelationEdge,
  RelationGraph,
  RelationSuggestion,
  ScanState,
  SortKey,
  SystemInfo,
  DuplicateGroup,
  FailedMedia,
  MediaFlag,
  PrivacyInfo,
  ProcessingSnapshot,
  SearchSuggestions,
  TimelineMonth
} from './types'

let baseUrl = 'http://127.0.0.1:8756'

/** Resolve the backend port from the Electron main process (dev + prod). */
export async function initApi(): Promise<void> {
  try {
    const port = await window.memora?.getBackendPort()
    if (port) baseUrl = `http://127.0.0.1:${port}`
  } catch {
    // running outside Electron (e.g. plain browser dev) — keep default
  }
}

export function thumbUrl(id: number): string {
  return `${baseUrl}/api/thumb/${id}`
}
export function fileUrl(id: number): string {
  return `${baseUrl}/api/file/${id}`
}
/** Browser-renderable image (converts HEIC/TIFF to JPEG server-side). */
export function displayUrl(id: number): string {
  return `${baseUrl}/api/display/${id}`
}
export function personFaceUrl(personId: number, mediaId?: number): string {
  const base = `${baseUrl}/api/people/${personId}/face`
  return mediaId ? `${base}?media_id=${mediaId}` : base
}
/** Leaflet tile template routed through the local caching proxy.
 *  style: 'light' | 'dark' | 'voyager' (CARTO basemaps). */
export function tileUrlTemplate(style: 'light' | 'dark' | 'voyager'): string {
  return `${baseUrl}/api/tile/${style}/{z}/{x}/{y}`
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => req<{ status: string }>('/api/health'),
  stats: () => req<LibraryStats>('/api/stats'),
  system: () => req<SystemInfo>('/api/system'),

  // folders + scanning
  folders: () => req<{ folders: Folder[] }>('/api/folders'),
  addFolder: (path: string) =>
    req<{ id: number }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ path })
    }),
  scan: (folderIds?: number[]) =>
    req<{ started: boolean }>('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ folder_ids: folderIds ?? null })
    }),
  processAi: () => req<{ started: boolean }>('/api/ai/process', { method: 'POST' }),
  removeFolder: (id: number) =>
    req<{ removed: number }>(`/api/folders/${id}`, { method: 'DELETE' }),
  setFolderWatch: (id: number, watch: boolean) =>
    req<{ ok: boolean }>(`/api/folders/${id}/watch`, {
      method: 'POST',
      body: JSON.stringify({ watch })
    }),

  // processing center
  processing: () => req<ProcessingSnapshot>('/api/processing'),
  processingFailed: () => req<{ failed: FailedMedia[] }>('/api/processing/failed'),
  processingAction: (action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry') =>
    req<{ ok?: boolean; retried?: number }>(`/api/processing/${action}`, { method: 'POST' }),
  privacy: () => req<PrivacyInfo>('/api/privacy'),
  duplicates: () => req<{ groups: DuplicateGroup[] }>('/api/duplicates'),
  scanStatus: () => req<ScanState>('/api/scan/status'),

  // media
  media: (view: LibraryView, sort: SortKey, limit: number, offset: number) =>
    req<MediaPage>(
      `/api/media?view=${view}&sort=${sort}&limit=${limit}&offset=${offset}`
    ),
  mediaDetail: (id: number) => req<MediaDetail>(`/api/media/${id}`),
  setFlag: (id: number, flag: string, value: boolean) =>
    req<{ ok: boolean }>(`/api/media/${id}/flag`, {
      method: 'POST',
      body: JSON.stringify({ flag, value })
    }),
  similar: (id: number) => req<{ items: MediaItem[] }>(`/api/media/${id}/similar`),
  setFlags: (ids: number[], flag: MediaFlag, value: boolean) =>
    req<{ changed: number }>('/api/media/flags', {
      method: 'POST',
      body: JSON.stringify({ media_ids: ids, flag, value })
    }),
  timeline: (view: LibraryView, sort: SortKey) =>
    req<{ months: TimelineMonth[] }>(`/api/media/timeline?view=${view}&sort=${sort}`),
  restoreTrash: () => req<{ restored: number }>('/api/trash/restore', { method: 'POST' }),
  emptyTrash: () => req<{ removed: number }>('/api/trash/empty', { method: 'POST' }),
  addTag: (id: number, label: string) =>
    req<{ tag: { id: number; kind: string; label: string; confidence: number } }>(
      `/api/media/${id}/tags`,
      { method: 'POST', body: JSON.stringify({ label }) }
    ),
  deleteTag: (id: number, tagId: number) =>
    req<{ ok: boolean }>(`/api/media/${id}/tags/${tagId}`, { method: 'DELETE' }),

  // people
  people: (includeHidden = false) =>
    req<{ people: Person[] }>(`/api/people?include_hidden=${includeHidden}`),
  renamePerson: (id: number, name: string | null) =>
    req<{ ok: boolean }>(`/api/people/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  hidePerson: (id: number, hidden: boolean) =>
    req<{ ok: boolean }>(`/api/people/${id}/hide`, {
      method: 'POST',
      body: JSON.stringify({ hidden })
    }),
  mergePeople: (sourceId: number, targetId: number) =>
    req<{ ok: boolean }>('/api/people/merge', {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, target_id: targetId })
    }),
  personMedia: (id: number) => req<{ items: MediaItem[] }>(`/api/people/${id}/media`),
  setPersonCover: (id: number, mediaId: number) =>
    req<{ ok: boolean }>(`/api/people/${id}/cover`, {
      method: 'POST',
      body: JSON.stringify({ media_id: mediaId })
    }),
  splitPerson: (id: number, mediaIds: number[]) =>
    req<{ new_person_id: number | null }>(`/api/people/${id}/split`, {
      method: 'POST',
      body: JSON.stringify({ media_ids: mediaIds })
    }),

  // search
  search: (q: string, personId?: number) =>
    req<{ query: string; items: MediaItem[] }>(
      `/api/search?q=${encodeURIComponent(q)}${personId ? `&person_id=${personId}` : ''}`
    ),
  suggest: (q: string) =>
    req<SearchSuggestions>(`/api/search/suggest?q=${encodeURIComponent(q)}`),

  // places
  places: () => req<{ places: Place[] }>('/api/places'),
  placeMedia: (key: string) =>
    req<{ items: MediaItem[] }>(`/api/places/media?key=${encodeURIComponent(key)}`),
  geoMedia: (sort: 'newest' | 'oldest' = 'newest') =>
    req<{ items: MediaItem[] }>(`/api/geo/media?sort=${sort}`),
  tileStats: () => req<{ tiles: number; bytes: number }>('/api/tiles/stats'),
  clearTiles: () =>
    req<{ cleared: { tiles: number; bytes: number } }>('/api/tiles/clear', {
      method: 'POST'
    }),

  // export
  exportPerson: (personId: number, dest: string) =>
    req<{ exported: number; skipped: number; dest: string }>('/api/export/person', {
      method: 'POST',
      body: JSON.stringify({ person_id: personId, dest })
    }),

  // relations
  relations: () => req<RelationGraph>('/api/relations'),
  relationSuggestions: () =>
    req<{ suggestions: RelationSuggestion[] }>('/api/relations/suggestions'),
  familySuggestions: () =>
    req<{ suggestions: FamilySuggestion[] }>('/api/relations/family-suggestions'),
  autoConnectRelations: (minShared: number) =>
    req<{ created: number }>('/api/relations/auto', {
      method: 'POST',
      body: JSON.stringify({ min_shared: minShared })
    }),
  addRelation: (personA: number, personB: number, label: string, directed = false) =>
    req<{ relation: RelationEdge }>('/api/relations', {
      method: 'POST',
      body: JSON.stringify({
        person_a: personA,
        person_b: personB,
        label,
        directed
      })
    }),
  deleteRelation: (relId: number) =>
    req<{ ok: boolean }>(`/api/relations/${relId}`, { method: 'DELETE' }),

  // albums
  albums: () => req<{ albums: Album[] }>('/api/albums'),
  createAlbum: (name: string) =>
    req<{ id: number }>('/api/albums', {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  addToAlbum: (albumId: number, mediaIds: number[]) =>
    req<{ added: number }>(`/api/albums/${albumId}/media`, {
      method: 'POST',
      body: JSON.stringify({ media_ids: mediaIds })
    }),
  albumMedia: (albumId: number) =>
    req<{ items: MediaItem[] }>(`/api/albums/${albumId}/media`)
}

/** Fired after anything that changes library counts (flags, trash, scans). */
export const LIBRARY_CHANGED = 'memora:library-changed'
export function emitLibraryChanged(): void {
  window.dispatchEvent(new Event(LIBRARY_CHANGED))
}
