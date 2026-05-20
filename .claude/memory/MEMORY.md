# Session notes — Sentinel-2 Temporal Mosaics on deck.gl-raster

**Date opened:** 2026-05-19
**Predecessor:** `cdl-lonboard-05-2026` (USDA CDL on MPC). The prior
session's full retrospective is preserved at
`./PRIOR_CDL_MEMORY.md`; the issue draft for lonboard's
`RasterLayer.from_stac_items` is at `./from_stac_items_issue.md`.

## What we're building

A browser app rendering Earth Genome's Sentinel-2 Temporal Mosaics
collection (`source.coop/earthgenome/sentinel2-temporal-mosaics`)
client-side via DevSeed's `MosaicLayer` + `COGLayer`. Starting with
2024 items. Goal: validate the COG pyramid workflow at a noticeably
larger per-tile footprint than CDL — TCI assets are ~400 MB each.

## Key decisions, this session

1. **TCI over per-band composition.** Items carry both raw bands
   (B01..B12, B8A) and a precomputed 3-band TCI RGB. We use TCI for the
   first cut — simplest path to pixels, no shader composition needed.
   If/when we want NDVI or false-color, swap in B04/B08-based assets
   and a per-band fetcher.
2. **Runtime STAC fetch, not pre-baked JSON.** Unlike the CDL app
   (which baked MPC SAS-signed hrefs into `minimal_stac.json` because
   they expire ~1hr), source.coop URLs are public and stable.
   `src/stac.ts` pages through `stac.earthgenome.org/search` on app
   mount. CORS verified open on both STAC API and data CDN.
3. **No picking, no stats, no category filter.** User explicitly asked
   for a thinner v0. The dashboard/picking/category-filter code from
   the CDL app is *not* carried over.
4. **Web Mercator simplification.** Source data is EPSG:3857 so no
   in-shader reprojection (CDL needed EPSG:5070 → Mercator). Dropped
   `proj.ts` and the `proj4` dep.
5. **Branch hygiene.** User wants a new branch per feature.
   - `main`: initial copy of the cdl-lonboard scaffold (pre-adapt).
   - `sentinel2-tci-mosaic`: first working Sentinel-2 TCI render.

## Stack (carried from CDL session — still applies)

- **`@developmentseed/deck.gl-raster`** (0.7.0) — WebGL2/WebGPU raster
  primitives. `RasterModule` pipeline pattern; `CreateTexture` GPU
  module uploads a texture into the render path. Custom shader modules
  (like our `discard-black`) plug into the `DECKGL_FILTER_COLOR`
  injection point.
- **`@developmentseed/deck.gl-geotiff`** (0.7.0) — `MosaicLayer` +
  `COGLayer`. MosaicLayer takes a sources array; for each visible map
  tile, asks which sources intersect, hands each one to COGLayer,
  which in turn fans out byte-range reads to internal COG tiles via
  `@developmentseed/geotiff`.
- **`@developmentseed/geotiff`** (0.7.0) — Browser COG reader.
  `GeoTIFF.fromUrl` does a small header fetch; `fetchTile(x,y)` does
  ranged reads. Returns `array.layout` of either `pixel-interleaved`
  or `band-separate`.
- **`@deck.gl/mapbox` `MapboxOverlay`** — Glues deck.gl into a maplibre
  map with `interleaved: true` so deck layers render under map labels
  via `beforeId`.

## TCI tile shape (verified from sample item `20NPK_2024-04-01_2024-08-01`)

- Size on disk: 395,665,861 bytes (~377 MiB) for one MGRS tile.
- `accept-ranges: bytes`, CORS open (verified Nov 2026).
- 3-band uint8 pixel-interleaved (assumed; will confirm at runtime).
- TCI values are scaled-and-stretched RGB. Pixels with all zeros are
  no-data/mask fill — shader discards `r+g+b < 0.01`.

## Files (final layout)

```
.
├── CLAUDE.md                     # project README + handoff doc
├── .claude/memory/
│   ├── MEMORY.md                 # this file
│   ├── PRIOR_CDL_MEMORY.md       # full CDL session retrospective
│   └── from_stac_items_issue.md  # lonboard issue draft (carried)
├── .gitignore                    # ignores .venv, node_modules, .claude/memory, .DS_Store
└── web/
    ├── index.html
    ├── package.json              # renamed; dropped proj4
    ├── tsconfig.json
    ├── vite.config.ts            # dropped regenStacPlugin
    └── src/
        ├── main.tsx
        ├── App.tsx               # MosaicLayer + COGLayer + discardBlack shader
        └── stac.ts               # runtime STAC client (search + pagination)
```

Deleted from the CDL inheritance:
- `web/scripts/gen_stac.py`, `web/scripts/gen_palette.py`
- `web/vite-plugin-regen-stac.ts`
- `web/src/{cdlShaders,categories,stats,pick,proj}.ts`
- `web/src/{minimal_stac,palette}.json`

## Open items / next steps

- [ ] `pnpm install` and verify it actually paints in the browser.
  Most likely first bugs:
  1. `array.layout` may not match the two shapes `getTileData` knows
     about (`band-separate` 3-band, or `pixel-interleaved` 3- or
     4-band). If it's something else we'll throw a clear error.
  2. CreateTexture in deck.gl-raster 0.7 may want a specific
     texture-data shape; verify against naip-mosaic which works.
  3. MosaicLayer may need `epsgResolver` even for Mercator data —
     naip example didn't pass one. Confirm.
- [ ] Confirm TCI tile internal tile size — if it's 1024 or 2048,
  byte-range reads are bigger than CDL's 512s. Affects first paint.
- [ ] Decide on global-vs-bbox STAC search. Current: global 2024. May
  want viewport-driven refetch for any zoom > some threshold.
- [ ] Per-band false-color (B08/B04/B03 NIR composite) as a next
  branch — exercises the actual band-stacking path NAIP uses.
- [ ] Picking — user said deferred. ~50–100 lines using `findSource`
  + re-`fetchTile` pattern from the CDL app.

## Session 2026-05-20 (branch `overview-mosaic` → main)

**RGB seams — actually fixed.** Root cause was NOT "per-item independent tile
grids" (the prior session's theory; the deck.gl-raster naip-mosaic example
mosaics many per-item COGLayers seam-free, disproving it). It was
`MultiCOGLayer` compositing three *separately-tiled single-band* COGs
(B04/B03/B02) that don't co-register sub-pixel. Fix: render the single
precomposed 3-band **TCI** COG (`assets.visual`) via one **`COGLayer`** per item
under `MosaicLayer` — exactly the naip pattern (`getTileData` → `CreateTexture`
+ `discardBlack`). This was the repo's *original* design; the seam appeared when
RGB was later rerouted through MultiCOGLayer. NDVI stays on MultiCOGLayer
(needs B08/B04 ratio; already seam-free). The BitmapLayer overview + zoom-gate
experiment was abandoned (looked worse) and deleted. See `docs/SEAMS.md`.

**RGB brightness** is now a uniform `ScaleColor` gain on the TCI texture
(`web/src/shaders/scaleColor.ts`, `renderTile.ts`), default ×1.0 — TCI is
pre-stretched 8-bit so the old raw-band `LinearRescale` no longer applied.

**Place search (Photon, no LLM):** `src/geocode.ts` + `src/PlaceSearch.tsx`.
Debounced autocomplete, keyboard nav, marker w/ toggle, `resultToBbox` margin +
clamp. `STAC_BBOX` is now `bbox` state driving the fetch. Coverage: source.coop
is the only CORS-open host; `fetchStacItems` returns `{items, rejected}` and the
panel messages when an AOI has zero usable items.

**Data overlap (left intentionally):** items are ANNUAL composites
(`MGRS_YYYY-01-01_YYYY+1-01-01`). A full-year query also matches the adjacent
year's annual at the Jan-1 boundary → each tile returns twice (e.g. Yuma: 32
items / 16 tiles). We KEEP the overlap so a cloud hole in one year backfills via
the other through discardBlack. (Dedup = nudge datetime to `01-02 → 12-30`, if
ever wanted for speed.) This is the equivalent of *not* reducing the time axis —
Earth Genome already did the per-scene `.median(dim=time)` server-side; the only
remaining "time axis" is *which* annual, a selection not a reduction.

**HMR footgun:** an in-`App.tsx` component (`PlaceSearch`) referenced across the
`InfoPanel` boundary tripped react-refresh's "X is not defined" on every hot
update — a false crash that blanked the map and froze the dropdown. Fix: keep
panel subcomponents in their own files. Hard reload clears a corrupted session.

**Benign console noise:** `AbortError: signal is aborted without reason` from
deck.gl-geotiff on AOI change = in-flight COG fetches cancelled. Not a failure;
library-level log, not worth patching.

## Conduct

Inherits global `~/CLAUDE.md`. No flattery, no unsolicited critique,
no filler statements. Peer-level directness.
