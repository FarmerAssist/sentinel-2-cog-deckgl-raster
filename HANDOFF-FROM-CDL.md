# Why the S2 app isn't rendering — handoff from `cdl-lonboard-05-2026`

Written by Claude after looking at `web/src/App.tsx`, `loadGeotiff.ts`,
`stac.ts`, and comparing against the working CDL mosaic app and the
upstream `naip-mosaic` reference example. The framing of this project
(stress-test of large COGs over the mosaic engine) is sound; the file
size of the source COGs has essentially no impact on client memory or
on what's needed to make it render. What's wrong is more boring: two
required hooks are missing from the `COGLayer` config, and a shader
module the README assumes exists isn't actually defined anywhere.

## TL;DR

The current `COGLayer` config is missing both `getTileData` and
`renderTile`. Without them deck.gl-raster fetches range bytes but has
no way to turn them into a texture or to draw anything to the screen.
The app currently does nothing visible because of this, not because of
anything CORS/STAC/big-COG-related.

Three fixes, in dependency order:

1. Add a `getTileData` that decodes the 3-band TCI tile and uploads it
   as an `rgba8unorm` texture (pad band 4 to 255).
2. Add a `renderTile` that wires `[CreateTexture, discardBlack, SetAlpha1]`.
3. Actually write the `discardBlack` shader module — it's mentioned in
   `CLAUDE.md` ("discards `r+g+b < 0.01`") but doesn't exist in the
   source tree.

After those three, you'll see pixels. The current "first-load is 1GB
and nothing happens" experience is a render-pipeline gap, not a memory
or data-size problem.

---

## What's missing, in detail

### 1. `getTileData` not provided

The CDL app passes a `getTileData` to `COGLayer` (`web/src/App.tsx`,
`makeGetTileData`). It does the Range fetch, validates the tile array,
and creates an `r8uint` GPU texture. S2 needs the same, but for 3-band
uint8 RGB (pixel-interleaved per the `CLAUDE.md` note) padded to RGBA
because WebGPU sampled textures need 4 channels:

```ts
// web/src/getTileData.ts (new file)
import type { GetTileDataOptions } from "@developmentseed/deck.gl-geotiff";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";

export type S2TileData = {
  width: number;
  height: number;
  texture: Texture;
};

export async function getTileData(
  image: GeoTIFF | Overview,
  options: GetTileDataOptions,
): Promise<S2TileData> {
  const { device, x, y, signal } = options;
  const tile = await image.fetchTile(x, y, { signal, boundless: false });
  const { array } = tile;
  const { width, height } = array;

  if (array.layout === "band-separate") {
    throw new Error("Sentinel-2 TCI expected pixel-interleaved");
  }

  // TCI is 3-band RGB uint8. Pad to RGBA (alpha = 255) for upload.
  const src = array.data;
  if (!(src instanceof Uint8Array)) {
    throw new Error(`expected Uint8Array, got ${src?.constructor?.name}`);
  }
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = src[i * 3];
    rgba[i * 4 + 1] = src[i * 3 + 1];
    rgba[i * 4 + 2] = src[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }

  const texture = device.createTexture({
    data: rgba,
    format: "rgba8unorm",
    width,
    height,
    sampler: {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });

  return { width, height, texture };
}
```

(Compare with `naip-mosaic` `getTileData` — same shape, but naip is
already 4-band so no padding step.)

### 2. `renderTile` not provided

The CDL app wires a per-tile shader pipeline via `renderTile`. Without
one, `COGLayer` has nothing to draw with. For TCI you want:

```ts
// web/src/renderTile.ts (new file)
import type {
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { S2TileData } from "./getTileData";
import { discardBlack } from "./discardBlack";

export function renderTile(tileData: S2TileData): RenderTileResult {
  const renderPipeline: RasterModule[] = [
    { module: CreateTexture, props: { textureName: tileData.texture } },
    { module: discardBlack },
  ];
  return { renderPipeline };
}
```

Note: `naip-mosaic` adds a `SetAlpha1` module because its 4th band is
NIR, not alpha — it stomps the alpha channel to 1.0 so the image is
opaque. For TCI we already wrote alpha=255 in `getTileData`, so we can
skip `SetAlpha1`. The `discardBlack` module replaces the alpha mutation
with a "drop no-data fill" rule, which is what the `CLAUDE.md`
description asked for.

### 3. `discardBlack` shader module needs to actually exist

The `CLAUDE.md` says:

> TCI fill is 0,0,0. The shader discards `r+g+b < 0.01` so the basemap
> shows through.

…but there's no such module in `src/`. Without it, TCI's (0,0,0) no-data
fill paints a black rectangle over the basemap for every tile — looks
like the basemap is broken even if everything else is working.

```ts
// web/src/discardBlack.ts (new file)
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Discards fragments where r+g+b is effectively zero. Sentinel-2 TCI
 * uses (0,0,0) as the no-data fill, so this lets the basemap show
 * through outside the imaged footprint instead of painting it black.
 */
export const discardBlack = {
  name: "discard-black",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.01) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;
```

### 4. Wire it in `App.tsx`

```ts
import { getTileData } from "./getTileData";
import { renderTile } from "./renderTile";

// inside the MosaicLayer's renderSource:
renderSource: (source, { data, signal }) => {
  if (!data) return null;
  return new COGLayer<S2TileData>({
    id: `s2-cog-${source.id}`,
    geotiff: data,
    epsgResolver,
    getTileData,   // ← new
    renderTile,    // ← new
    signal,
  });
},
```

That's the whole render-pipeline gap. After that change, hard-reload
and you should see Sentinel-2 imagery filling visible tiles.

---

## Separate issue: initial view at zoom 2 = global

Once #1–4 land, you'll hit a memory wall. The current
`initialViewState` is `{ longitude: 0, latitude: 20, zoom: 2 }` —
that's whole-Earth view. Sentinel-2 mosaics are MGRS-tile granularity
(~100 km each). Global 2024 means thousands of items. The CORS filter
in `stac.ts` to `data.source.coop` trims that to seasonal 2024 only,
but it's still a lot.

For comparison: the CDL mosaic loads 1095 sources at CONUS view (z=3.5)
and costs ~1GB resident on the tab. That's not a leak — it's just the
cost of "open every COG you'd render and decode one overview tile per
COG." At z=2 globally with potentially several thousand source.coop
items, expect worse.

Two cheap fixes, pick one:

- **Start zoomed in.** Change `initialViewState` to a regional bbox
  (e.g. `{ longitude: -120, latitude: 37, zoom: 5 }` for California)
  and let the user pan/zoom out. Memory and first-paint cost scale
  with visible-source count, not data size.
- **Bbox-filter at STAC.** Pass a `bbox` to `fetchStacItems` so you
  only enumerate items in a reasonable area. Combine with a higher
  `minZoom` on the maplibre `Map` if you want to prevent the user
  from zooming out into "thousands of sources" land.

The CDL app deliberately accepts the 1GB cost because CONUS is the
product. For a global S2 stress-test app, "user opens it at z=5 over
California, then pans" is a much friendlier default than "user opens
it at z=2 and watches their RAM fill."

---

## What's **not** the problem

Stating these out loud because they're plausible-sounding but unrelated:

- **400MB COG file size.** COGs are range-readable. The browser only
  fetches the byte ranges for tiles it needs at the current overview
  level. A 400MB COG and a 5MB COG cost the same memory if the
  visible-tile count and overview level are the same. The CLAUDE.md
  framing as a "stress test of the COG pyramid workflow" is a bit
  misleading — the COG pyramid is what makes file size *not* matter.
  The real stress test is "how many sources at once," which is an
  MGRS-tile-count problem, not a per-COG size problem.
- **CORS.** Already verified open. If items appear in `stacItems` they
  passed the host filter, and `data.source.coop` will serve range
  reads.
- **STAC pagination.** `fetchStacItems` follows `rel=next` to
  exhaustion. Slow first-paint at global view is real, but it's a UX
  problem, not a render problem.
- **`@chunkd/source-http` workaround in `loadGeotiff.ts`.** The HEAD
  preflight is defensible and unrelated to whether pixels appear on
  screen.
- **EPSG resolver.** Sentinel-2 is published in EPSG:3857 (Web
  Mercator); deck.gl-raster + `@developmentseed/proj` handle that
  without needing a custom WKT. No action needed there.

---

## Suggested order of work

1. Create `getTileData.ts`, `renderTile.ts`, `discardBlack.ts`.
2. Wire them into `App.tsx`.
3. Hard-reload — confirm pixels appear over the basemap.
4. If memory/first-paint feels bad, narrow `initialViewState` or pass
   a `bbox` to `fetchStacItems`.
5. Picking, stats, etc. — port from `cdl-lonboard-05-2026` later, none
   of it is needed to get the imagery rendering.

If after step 3 imagery still doesn't appear, the next thing to check
is the browser console for GLSL compile errors or luma.gl warnings
(`Binding sampler not set: Not found in shader layout` etc.). Add
`console.log` inside `getTileData` to confirm it's being invoked at all
— if it's not, the issue is in the `MosaicLayer` source-fanout (e.g.
`getCachedGeoTIFF` failing) rather than the render pipeline.
