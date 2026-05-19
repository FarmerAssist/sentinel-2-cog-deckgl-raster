import type { ShaderModule } from "@luma.gl/shadertools";

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

/**
 * Discards pixels where every sampled band is essentially zero — i.e. the
 * MultiCOGLayer `boundless: true` zero-padding outside the COG's data area.
 * Threshold is ~2 × the smallest representable r16unorm step so real low-
 * reflectance pixels (deep water, shadow) survive.
 *
 * Runs after CompositeBands, before any LinearRescale. Works for both:
 * - RGB mode (color.r+g+b = sum of three bands)
 * - NDVI mode (color.r+g = nir+red; color.b is 0 by composite, harmless to sum)
 */
export const discardBoundlessPadding = {
  name: "discard-boundless-padding",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.00005) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;
