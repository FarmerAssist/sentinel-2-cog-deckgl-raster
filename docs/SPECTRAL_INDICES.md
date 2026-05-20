# Spectral indices — what's built, and the catalog path

## Built now (curated)

A small registry of normalized-difference indices, all sharing one shader and
the existing `MultiCOGLayer` composite path. Adding one is a one-line entry in
`INDICES` (`web/src/renderPipeline.ts`) — just the two bands.

| index | formula                | bands (a, b) | reads        |
|-------|------------------------|--------------|--------------|
| NDVI  | (NIR − Red)/(NIR + Red)| B08, B04     | vegetation   |
| NDWI  | (Green − NIR)/(…)      | B03, B08     | open water   |
| NDBI  | (SWIR − NIR)/(…)       | B11, B08     | built-up     |
| NDMI  | (NIR − SWIR)/(…)       | B08, B11     | canopy moisture |

How it works:
- `INDICES[k]` declares `{ a, b }` band slots. `bandSlotsFor` maps them to STAC
  asset keys; `INDEX_COMPOSITE` packs `a → color.r`, `b → color.g`.
- `shaders/ndvi.ts` `NormalizedDifference` computes `(r − g)/(r + g)` — generic,
  so every index above reuses it unchanged.
- Pipeline: `discardBoundlessPadding → NormalizedDifference → LinearRescale →
  Colormap → ScaleColor` (`buildRenderPipeline`).
- Colormaps include divergent ramps (`rdylgn`, `rdbu`, `spectral`) already
  present in the bundled `colormaps.png` sprite — no sprite regen needed. A
  symmetric `[-1, 1]` rescale centers a divergent ramp at 0 ("auto-weight").

Required bands are gated in `stac.ts` (`REQUIRED_BANDS = B03,B04,B08,B11`);
items missing any are skipped so every listed index always renders.

### Adding a non-normalized-difference index (EVI, SAVI, BSI)

These need >2 bands and/or constants, so they don't fit `NormalizedDifference`.
Each wants a small dedicated shader (clone `shaders/ndvi.ts`), e.g. EVI:
`2.5 * (NIR − Red) / (NIR + 6*Red − 7.5*Blue + 1)`. Wire B02/B05 back into
`REQUIRED_BANDS` as needed. Keep them as explicit presets unless/until the
catalog path below is worth the lift.

## Future: awesome-spectral-indices catalog (planned, not built)

[awesome-spectral-indices](https://github.com/awesome-spectral-indices/awesome-spectral-indices)
ships a machine-readable JSON catalog (~250 indices) with, per index, a
`formula` string, the `bands` it references, and constant defaults. The generic
path:

1. **Fetch + filter** the catalog to indices whose band tokens are all
   available on this Sentinel-2 collection. Token → asset map:
   `N=B08, R=B04, G=B03, B=B02, RE1=B05, S1=B11, S2=B12`, etc.
2. **Codegen GLSL** from the `formula` string. The formulas are simple infix
   arithmetic over band tokens + named constants (`L`, `C1`, `C2`, `g`…).
   Parse to an AST and emit a `DECKGL_FILTER_COLOR` injection that reads each
   band from its packed color channel.
3. **Gate band requirements** per index (disable in the UI if a required band
   is missing / not CORS-open) and surface the catalog's constant defaults as
   sliders (reuse the existing range/scale UI).

### Hard parts (why it's deferred)
- **Formula → safe GLSL.** Need a real (small) expression parser, not string
  interpolation — guard against injection and unsupported ops, map `**`/`abs`/
  `max` to GLSL equivalents.
- **Channel budget.** The composite path packs into RGBA; indices needing >4
  bands need either multiple passes or a different upload strategy.
- **Constants & domains.** Each index has its own sensible rescale domain;
  `[-1,1]` is only right for normalized differences. The catalog doesn't always
  give a display range, so divergent-vs-sequential and center point need a
  heuristic or per-index override table.

When this lands, the curated `INDICES` registry becomes the fallback/"pinned
favorites" set and the catalog provides the long tail.
