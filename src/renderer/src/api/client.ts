import type {
  Album,
  Folder,
  LibraryStats,
  LibraryView,
  MediaDetail,
  MediaItem,
  MediaPage,
  Person,
  ScanState,
  SortKey
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

  // search
  search: (q: string) =>
    req<{ query: string; items: MediaItem[] }>(`/api/search?q=${encodeURIComponent(q)}`),

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
