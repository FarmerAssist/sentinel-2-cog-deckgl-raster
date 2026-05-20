# sentinel-2-cog-deckgl-raster

Browser-side rendering of Earth Genome's Sentinel-2 Temporal Mosaics
(source.coop/earthgenome/sentinel2-temporal-mosaics) using DevSeed's
`MosaicLayer` + `COGLayer` from `@developmentseed/deck.gl-geotiff`. No tile
server, no derived data, no hosting — the browser opens each per-tile COG
over HTTP Range and the mosaic engine fans out byte-range reads per visible
map tile.

This project is a deliberate **stress test of the COG pyramid workflow**:
TCI assets here are ~400 MB each (vs. ~5–20 MB for the CDL tiles in the
predecessor project `cdl-lonboard-05-2026`).

## Origin

Forked from `cdl-lonboard-05-2026` (USDA CDL on MPC). See
`.claude/memory/MEMORY.md` for the full stack/footgun retrospective that
carried over. The lift was small because:

- **Same client stack** — deck.gl-raster 0.7, deck.gl-geotiff 0.7,
  @developmentseed/geotiff 0.7, MapboxOverlay on maplibre, react-map-gl v8.
- **Simpler render pipeline** — Sentinel-2 TCI is already a 3-band uint8 RGB
  visualization product, so no palette LUT, no class-code shader, no
  category filter. Just `CreateTexture` + a tiny `discard-black` shader for
  no-data fill.
- **Web Mercator native** — collection is published in EPSG:3857, so no
  in-shader reprojection (CDL was EPSG:5070 Albers).
- **Public bucket, no signing** — source.coop is public CloudFront over S3.
  Dropped `gen_stac.py`, the SAS-refresh vite plugin, and obstore-style
  credentialing. STAC items fetched at runtime from
  `stac.earthgenome.org`.

## Data shape

Items look like `20NPK_2024-04-01_2024-08-01` (MGRS tile + 4-month window).
Assets per item: `B01..B12`, `B8A` (single-band per Sentinel-2 band) plus
`TCI` (3-band RGB visualization composite). We use **TCI** for the
first-pass app — it's the lowest-friction path to pixels on screen.

CRS: EPSG:3857.
Per-tile pixel layout: pixel-interleaved 3-band uint8 (padded to RGBA on
upload — WebGPU sampled textures need 4 channels).

## Architecture

```
stac.earthgenome.org  ──┐
   STAC /search          │  runtime fetch on mount (src/stac.ts)
                         ▼
                  PartialSTACItem[]  →  MosaicLayer (sources)
                                              │
                                              ▼ per visible map tile
                                       COGLayer (one per source)
                                              │
                                              ▼ HTTP Range
                          data.source.coop/earthgenome/.../TCI.tif
```

## Run

```bash
cd web
npm install
npm run dev         # http://localhost:5455
```

No data prebake. Items fetched live from the STAC API.

To target a different year/region, change `STAC_DATETIME` / add a `bbox`
in `src/App.tsx`. (TODO: viewport-driven STAC refetch.)

## Footguns (carried forward + new)

- **TCI fill is 0,0,0.** The shader discards `r+g+b < 0.01` so the basemap
  shows through. Don't treat (0,0,0) as a real pixel.
- **400 MB COGs.** First-touch header reads are bigger than CDL. If the
  initial viewport feels sluggish, that's the `geotiffCache` warming up.
- **MosaicLayer maxCacheSize=0** — header data lives in the module-level
  `geotiffCache`, not the TileLayer cache. Same pattern as naip-mosaic.
- **CORS verified open** (Nov 2026) on both `stac.earthgenome.org` and
  `data.source.coop`. If that ever changes, fall back to a baked
  `items.json`.
- **STAC pagination** — `stac.ts` follows `rel=next` until exhaustion or
  `maxItems`. Global 2024 may be a lot of items; consider bbox-filtering
  if first paint is slow.

## What's not here (vs. the CDL predecessor)

Deliberately dropped from the CDL app:

- `categories.ts`, `cdlShaders.ts`, `palette.json` — no palette lookup.
- `stats.ts` — no per-class histogram dashboard.
- `pick.ts` — no per-pixel picking (user said: not needed at start).
- `proj.ts` — no EPSG:5070 → 3857 reprojection (data is already 3857).
- `gen_stac.py`, `gen_palette.py`, `vite-plugin-regen-stac.ts` — no
  pre-bake step; STAC fetched at runtime.

If we need any of these back, the git history of `cdl-lonboard-05-2026`
has them.

## Tone & conduct

Inherits global rules from `~/CLAUDE.md`. No flattery, no unsolicited
critique, no "you're absolutely right." Treat the user as a peer.
