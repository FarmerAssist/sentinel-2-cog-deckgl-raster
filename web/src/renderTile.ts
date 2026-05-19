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
