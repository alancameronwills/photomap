# PhotoMap

A self-hosted interactive map for organising geotagged photos and drawing routes. Photos are placed automatically using their GPS EXIF data; nearby photos are grouped into a single point of interest. Routes can be drawn over any map layer, linked to photo locations, and edited interactively.

## Features

- **Photo POIs** — drop photos onto the map; GPS EXIF data places them automatically. Photos without GPS go to the current map centre. Nearby photos (within 10 m) are merged into one POI.
- **Map layers** — OpenStreetMap, ESRI Aerial, OpenTopoMap, and (with a MapTiler key) the NLS historic 6-inch OS survey. Zooming past a layer's native resolution switches automatically to Aerial and back.
- **Route editing** — draw multi-node routes, link nodes to POIs, insert nodes by clicking a route line, split routes, recolour routes per-route. Routes persist across sessions.
- **Edit / view modes** — all edits require a password. View mode is always the default on load; the session is remembered so the password is only asked once.
- **Bulk upload** — drag a folder of photos onto the map; GPS is extracted client-side before scaling so EXIF survives compression.

## Requirements

- Node.js 18+ (uses `--env-file`)
- npm

## Setup

```bash
git clone <repo>
cd photomap
npm install
cp .env.example .env   # then edit .env
npm start
```

Open `http://localhost:3000`.

### `.env` variables

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Password for Edit Mode | `changeme` |
| `SESSION_SECRET` | Session cookie signing key | `photomap-dev-secret` |
| `MAPTILER_KEY` | Enables NLS Historic OS layer | *(layer hidden)* |
| `PORT` | HTTP port | `3000` |

A free MapTiler API key is available at [maptiler.com](https://www.maptiler.com/). The NLS tileset used is `uk-osgb1888`.

## Usage

### Viewing

Click any POI marker to open a preview panel. Click **View Full** for a photo grid. Click photos to open the lightbox.

### Editing

Click **Edit Mode** in the toolbar and enter the password. In edit mode:

- **Click the map** to create a new POI (title, notes, photos).
- **Drag a POI marker** to reposition it.
- **Click a POI marker** to edit its title, notes, or photos.
- **Upload Photos** (toolbar) — bulk-import photos; GPS data is used to place and group them automatically.

### Route editing

Click **Edit Routes** (toolbar, visible in Edit Mode):

- **Start a route** — click any map location, POI, or existing route start/end node. Subsequent clicks extend the route.
- **Click a route line** to insert a node at that point.
- **Click a node** to select it, then:
  - **Delete Node** (or `Delete` key) — removes the node; deletes the route if fewer than 2 nodes remain.
  - **Undo** (or `Ctrl+Z`) — removes the last node you added in this session.
  - **Split Route** — deletes the selected node and creates a second route from the tail nodes.
  - **Delete Route** — removes the entire route.
  - **Colour picker** — changes the colour of the selected node's route.
- **Drag a node** to reposition it. Dragging a node close to a POI snaps and links it; dragging a linked node away breaks the link.

## Development

```bash
npm run dev    # nodemon; auto-restarts on file changes
```

The database (`photomap.db`) and uploaded files (`uploads/`) are created automatically and are gitignored. To reset, delete them and restart.
