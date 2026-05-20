import type { RasterModule } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  COLORMAP_INDEX,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { discardBoundlessPadding } from "./discardBlack";
import { NdviFromRG } from "./shaders/ndvi";

export type RenderMode = "rgb" | "ndvi";

/** Default RGB stretch ceiling in r16unorm units. 0.05 ≈ 3000 raw, TCI-ish. */
export const DEFAULT_RGB_RESCALE_MAX = 0.05;

export const NDVI_COLORMAPS = ["cividis", "viridis", "plasma"] as const;
export type NdviColormap = (typeof NDVI_COLORMAPS)[number];
export const DEFAULT_NDVI_COLORMAP: NdviColormap = "cividis";

/**
 * Source slot mapping fed to MultiCOGLayer for each mode.
 * Keys become band names; values are the STAC asset keys to pull URLs from.
 */
export const SOURCE_BANDS: Record<RenderMode, Record<string, "B02" | "B03" | "B04" | "B08">> = {
  rgb: { red: "B04", green: "B03", blue: "B02" },
  ndvi: { nir: "B08", red: "B04" },
};

export const COMPOSITE: Record<RenderMode, { r: string; g?: string; b?: string }> = {
  rgb: { r: "red", g: "green", b: "blue" },
  // Pack NIR into color.r and red into color.g for the NDVI shader.
  ndvi: { r: "nir", g: "red" },
};

export function buildRenderPipeline(
  mode: RenderMode,
  colormapTexture: Texture | null,
  opts: { rgbRescaleMax?: number; ndviColormap?: NdviColormap } = {},
): RasterModule[] {
  if (mode === "rgb") {
    // MultiCOGLayer uploads uint16 bands as r16unorm → sampler returns
    // value/65535 in [0,1]. 0.05 ≈ 3000 raw; matches deck.gl-raster
    // sentinel-2 example. Smaller = brighter.
    return [
      { module: discardBoundlessPadding },
      {
        module: LinearRescale,
        props: {
          rescaleMin: 0,
          rescaleMax: opts.rgbRescaleMax ?? DEFAULT_RGB_RESCALE_MAX,
        },
      },
    ];
  }
  // NDVI
  if (!colormapTexture) return [];
  return [
    { module: discardBoundlessPadding },
    { module: NdviFromRG },
    { module: LinearRescale, props: { rescaleMin: -1, rescaleMax: 1 } },
    {
      module: Colormap,
      props: {
        colormapTexture,
        colormapIndex: COLORMAP_INDEX[opts.ndviColormap ?? DEFAULT_NDVI_COLORMAP],
        reversed: false,
      },
    },
  ];
}
