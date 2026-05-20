# RGB tile-edge seams (NDVI is clean)

## Symptom

In **RGB** mode a faint regular grid of seams appears at tile boundaries —
visible at every zoom, including close in. In **NDVI (cividis)** the same
view is seam-free. Brightness slider doesn't change it.

## What it is NOT

- **Not radiometric / a data defect.** The Earth Genome temporal mosaic is
  advertised as seamless, and `gdalinfo /vsicurl/...` confirms every band
  (B02/B03/B04/B08/TCI) shares one CRS (EPSG:3857), origin, pixel size
  (19.109 m) and overview pyramid. The product is balanced.
- **Not transparent gaps.** `discardBoundlessPadding` runs first in *both*
  pipelines. If these were holes (basemap showing through), NDVI would show
  them too. It doesn't.

## Why RGB shows it and NDVI doesn't

- **RGB** renders *absolute* band values through `LinearRescale(0, 0.05)`.
  Any sub-pixel discontinuity at a tile edge becomes an absolute brightness
  step, stretched into visibility against the low-contrast forest.
- **NDVI** is a *normalized ratio* `(NIR − Red)/(NIR + Red)`. At a seam both
  bands shift together (same cause), so the ratio is stable → the
  discontinuity cancels. NDVI is inherently robust to exactly the per-edge
  offsets RGB exposes.

This asymmetry is the tell: the seam is an **absolute-value discontinuity at
tile boundaries**, introduced on the render side, not in the data.

## Where it comes from (the projection path)

deck.gl-raster reprojects **per tile**:

- `multi-cog-layer.ts:362` — `proj4(sourceProjection, "EPSG:3857")` builds a
  forward/inverse transform for every source. proj4 does **not** hard
  short-circuit `3857→3857` to identity; it still meshes each tile.
- `raster-reproject/src/delatin.ts` — builds a Delatin TIN mesh approximating
  the warp, refined until reprojection error < `maxError` (**default
  0.125 px**), then drapes the band texture over it.

Our architecture renders **one `MultiCOGLayer` per STAC item** under a single
`MosaicLayer`. Each item therefore builds its **own** tile grid and its **own**
reprojection mesh, independently. Along the edge shared by two adjacent items
the two meshes / grids can disagree at the sub-pixel level → the texture
warps/samples slightly differently on each side → a hairline seam.

## What we tried (2026-05-19) — none fixed it

| change                              | hypothesis                                   | result      |
| ---                                 | ---                                          | ---         |
| `maxError: 0.01`                    | tighten reprojection mesh tolerance          | no change   |
| `refinementStrategy: "no-overlap"`  | stop best-available overview-level mixing    | no change; also regressed zoom feel (tiles pop in blank) |

Both reverted. That maxError and refinement had zero effect points away from
mesh tolerance and overview mixing, and **at the per-item grid registration**
itself.

## The real fix (not done — significant work)

The seam is structural to "one independent `MultiCOGLayer` per item." To
eliminate it you'd need a **single shared mercator tile grid** across all
items, so adjacent items sample one common grid with no independent
per-item mesh:

- Fork / extend `MultiCOGLayer` (or `MosaicLayer`) so the whole mosaic meshes
  once against a shared tileset rather than per-item, OR
- Pre-mosaic to a single multi-band COG / overviews server-side (defeats the
  no-prebake premise), OR
- Accept it: NDVI is seam-free for analysis; RGB seams are cosmetic and only
  noticeable on low-contrast scenes. A darker basemap or gentler stretch
  reduces their salience.

## Practical guidance

- For analysis or screenshots that must be seamless, **use NDVI**.
- RGB is fine for browsing; the seams are faint and scene-dependent (worst on
  flat, dark, low-contrast cover like rainforest).
