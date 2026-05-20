import type { RasterModule } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  COLORMAP_INDEX,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { discardBoundlessPadding } from "./discardBlack";
import { NormalizedDifference } from "./shaders/ndvi";
import { ScaleColor } from "./shaders/scaleColor";

/** Sentinel-2 band assets we pull per item (RGB uses the precomposed TCI). */
export type BandKey = "B03" | "B04" | "B08" | "B11";

/**
 * Curated spectral-index registry (item 4). Every entry is a normalized
 * difference `(a - b) / (a + b)` so they all share one shader (`NormalizedDifference`)
 * and the existing MultiCOGLayer composite path — only the two band slots differ.
 * `a` is packed into color.r, `b` into color.g by the `composite` below.
 *
 * Adding a non-normalized-difference index (EVI, SAVI, BSI) means a dedicated
 * shader + constants; see docs/SPECTRAL_INDICES.md for the generic-formula path.
 */
export const INDICES = {
  ndvi: { label: "NDVI", a: "B08", b: "B04", desc: "vegetation" },
  ndwi: { label: "NDWI", a: "B03", b: "B08", desc: "water" },
  ndbi: { label: "NDBI", a: "B11", b: "B08", desc: "built-up" },
  ndmi: { label: "NDMI", a: "B08", b: "B11", desc: "moisture" },
} as const satisfies Record<string, { label: string; a: BandKey; b: BandKey; desc: string }>;

export type IndexKey = keyof typeof INDICES;
export const INDEX_KEYS = Object.keys(INDICES) as IndexKey[];

/** "rgb" renders the precomposed TCI via COGLayer; the rest are GPU indices. */
export type RenderMode = "rgb" | IndexKey;

export function isIndexMode(mode: RenderMode): mode is IndexKey {
  return mode !== "rgb";
}

/** Colormaps exposed for index modes — sequential + divergent (all in the sprite). */
export const INDEX_COLORMAPS = [
  "cividis",
  "viridis",
  "plasma",
  "rdylgn",
  "rdbu",
  "spectral",
] as const;
export type IndexColormap = (typeof INDEX_COLORMAPS)[number];
export const DEFAULT_NDVI_COLORMAP: IndexColormap = "cividis";

/** Default index stretch range — symmetric [-1, 1] centers divergent ramps at 0. */
export const DEFAULT_NDVI_RANGE: [number, number] = [-1, 1];

/** Default post-colormap multiplier; 1.0 = unchanged, <1 darkens. */
export const DEFAULT_NDVI_SCALE = 1.0;

/** Back-compat alias used by App's UI. */
export const NDVI_COLORMAPS = INDEX_COLORMAPS;
export type NdviColormap = IndexColormap;

/**
 * MultiCOGLayer `sources` slot → STAC asset map for an index mode. Slot names
 * (`a`, `b`) are packed into color channels by COMPOSITE below.
 */
export function bandSlotsFor(mode: IndexKey): Record<"a" | "b", BandKey> {
  const { a, b } = INDICES[mode];
  return { a, b };
}

/** Composite packing: index input `a`→color.r, `b`→color.g (uniform for all indices). */
export const INDEX_COMPOSITE = { r: "a", g: "b" } as const;

export function buildRenderPipeline(
  mode: RenderMode,
  colormapTexture: Texture | null,
  opts: {
    ndviColormap?: IndexColormap;
    ndviRange?: [number, number];
    ndviScale?: number;
    ndviReversed?: boolean;
  } = {},
): RasterModule[] {
  if (mode === "rgb") return []; // RGB is handled by COGLayer/renderTile, not here.
  if (!colormapTexture) return [];
  const [lo, hi] = opts.ndviRange ?? DEFAULT_NDVI_RANGE;
  return [
    { module: discardBoundlessPadding },
    { module: NormalizedDifference },
    { module: LinearRescale, props: { rescaleMin: lo, rescaleMax: hi } },
    {
      module: Colormap,
      props: {
        colormapTexture,
        colormapIndex: COLORMAP_INDEX[opts.ndviColormap ?? DEFAULT_NDVI_COLORMAP],
        reversed: opts.ndviReversed ?? false,
      },
    },
    {
      module: ScaleColor,
      props: { factor: opts.ndviScale ?? DEFAULT_NDVI_SCALE },
    },
  ];
}
