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
