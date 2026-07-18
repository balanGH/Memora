# Memora

A modern, **fully offline** desktop photo-management app inspired by Google Photos.
Everything — your files, metadata, thumbnails, and AI results — stays on your machine.
No cloud, no telemetry, no tracking.

> **Status: working vertical slice.** The end-to-end core runs today: add folders →
> scan → generate thumbnails → browse a Google-Photos-style timeline → open the
> full-screen viewer. Face recognition, object/scene tagging, OCR, and CLIP-style
> semantic search are wired through clean service interfaces backed by **deterministic
> stub models**, so the whole app runs with zero multi-GB model downloads. Swapping in
> real InsightFace / YOLO / CLIP / PaddleOCR later requires no changes to callers.

## Architecture

```
┌────────────────────────── Electron (main process) ──────────────────────────┐
│  • Spawns the Python backend on localhost      • Native folder picker          │
│  • Creates the app window                      • System theme detection        │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ contextBridge (preload)
┌───────────────▼──────────────┐        HTTP (127.0.0.1)        ┌────────────────┐
│  Renderer: React + TS + MUI  │  ───────────────────────────► │  FastAPI (Py)  │
│  • Timeline (virtual scroll) │                                │  • SQLite      │
│  • Photo viewer / People /   │  ◄─────────────────────────── │  • Scanner     │
│    Search / Albums / Settings│        JSON + image bytes      │  • AI pipeline │
└──────────────────────────────┘                                └────────────────┘
```

- **Frontend:** Electron + React + TypeScript + Material UI, bundled with `electron-vite`.
  Virtualized timeline via `react-virtuoso`, justified (masonry-style) rows, sticky date
  headers, dark/light themes.
- **Backend:** Python + FastAPI + SQLite (stdlib `sqlite3`, WAL mode). Pillow for EXIF and
  thumbnails.
- **AI seam:** `backend/app/ai/interfaces.py` defines `Protocol`s for faces, tagging, OCR,
  and embeddings. `stub.py` implements them deterministically today.

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.10+ on your `PATH`

## Setup

```bash
# 1. Frontend dependencies
npm install

# 2. Backend virtualenv + dependencies
npm run backend:install
# (equivalent to: python -m venv backend/.venv &&
#  backend/.venv/Scripts/python -m pip install -r backend/requirements.txt)
```

## Run

```bash
npm run dev
```

`electron-vite dev` launches the desktop app. The Electron main process automatically
starts the FastAPI backend (preferring `backend/.venv`), so you do **not** need a
separate terminal.

Then, in the app:

1. Go to **Settings → Add folder** and pick a folder of photos.
2. Click **Scan for new media** — thumbnails generate and the timeline fills in.
3. Click **Run AI processing** — faces cluster into **People**, and objects/scenes/OCR
   become searchable. Try searching `dog`, `beach`, or `sunset`.

### Running the backend on its own

```bash
npm run backend:dev          # python backend/run.py
# API served at http://127.0.0.1:8756  (docs at /docs)
```

## Data & privacy

All state lives in **`~/.memora/`**:

- `memora.db` — SQLite index (folders, media, faces, people, tags, albums)
- `thumbnails/` — cached WebP thumbnails

Your original photos are **never moved, modified, or uploaded**. Delete `~/.memora/` to
reset the app completely. Override the location with the `MEMORA_DATA_DIR` env var.

## Build

```bash
npm run build        # type-checks + bundles main, preload, and renderer into out/
npm run typecheck    # TS only
```

## Swapping in real AI models

1. `pip install` the models in `backend/requirements.txt` (see the commented section).
2. Add a module beside `backend/app/ai/stub.py` (e.g. `insight.py`) whose classes satisfy
   the `Protocol`s in `interfaces.py`.
3. Point the factory in `backend/app/ai/__init__.py` (`get_ai`) at the real
   implementations.

No route, repository, or frontend code changes — the seam is the only thing that moves.

## Feature status

| Area | State |
|------|-------|
| Folder scan, incremental indexing, thumbnails | ✅ Working |
| SQLite metadata, EXIF (date, camera, GPS) | ✅ Working |
| Timeline (day/month/year grouping, sort, virtual scroll) | ✅ Working |
| Full-screen viewer (zoom, pan, EXIF panel, keyboard shortcuts) | ✅ Working |
| Favorites / Archive / Hidden / Trash | ✅ Working |
| Albums (manual) | ✅ Working |
| People clustering, rename, hide, merge | ✅ Working (stub embeddings) |
| Search (people / object / scene / OCR / semantic) | ✅ Working (stub) |
| Similar-image search | ✅ Working (stub) |
| Real InsightFace / YOLO / CLIP / PaddleOCR | 🔌 Interface ready, not wired |
| Video thumbnails, non-destructive editing, GPS map view, packaging | 🚧 Planned |

## Keyboard shortcuts (viewer)

`←` / `→` navigate · `+` / `-` zoom · `0` reset zoom · `f` favorite · `i` info · `Esc` close
