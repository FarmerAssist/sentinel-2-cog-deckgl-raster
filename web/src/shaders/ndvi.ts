import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * NDVI from a NIR-in-r / red-in-g packed color.
 *
 * Runs after MultiCOGLayer's auto-prepended CompositeBands module, which
 * has already written `composite.r` (NIR) into `color.r` and `composite.g`
 * (red) into `color.g`. We compute NDVI = (NIR - red) / (NIR + red) into
 * `color.r` in the range [-1, 1], and a downstream LinearRescale then
 * maps it to [0, 1] for Colormap sampling.
 */
export const NdviFromRG = {
  name: "ndvi-from-rg",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float nir = color.r;
      float red = color.g;
      float denom = nir + red;
      color.r = denom > 0.0 ? (nir - red) / denom : 0.0;
    `,
  },
} as const satisfies ShaderModule;
