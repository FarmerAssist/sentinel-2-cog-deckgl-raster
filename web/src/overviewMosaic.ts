import { loadGeoTIFF } from "./loadGeotiff";

/**
 * Decode each item's coarsest TCI overview into a single ImageBitmap for
 * BitmapLayer. One quad per item, reprojected by the GPU as a whole — adjacent
 * items share exact lng/lat edges, so the mosaic is seamless (unlike the per-
 * tile MultiCOGLayer path, see docs/SEAMS.md).
 *
 * The coarsest overview on this collection is ~156 px (single tile), so this
 * is one small Range read + decode per item. No-data (0,0,0) fill is made
 * transparent so the basemap shows through item gaps.
 */
const overviewCache = new Map<string, Promise<ImageBitmap>>();

export function getOverviewImage(tciHref: string): Promise<ImageBitmap> {
  let p = overviewCache.get(tciHref);
  if (!p) {
    p = loadOverview(tciHref).catch((err) => {
      overviewCache.delete(tciHref);
      throw err;
    });
    overviewCache.set(tciHref, p);
  }
  return p;
}

async function loadOverview(tciHref: string): Promise<ImageBitmap> {
  const tiff = await loadGeoTIFF(tciHref);
  // Coarsest overview = last in the finest→coarsest list; single tile here.
  const ov = tiff.overviews[tiff.overviews.length - 1];
  const src = ov ?? tiff;
  const tile = await src.fetchTile(0, 0, { boundless: false });
  const { array } = tile;
  const { width, height } = array;
  if (array.layout === "band-separate") {
    throw new Error("TCI overview expected pixel-interleaved");
  }
  const data = array.data;
  if (!(data instanceof Uint8Array)) {
    throw new Error(`TCI overview expected Uint8Array, got ${data?.constructor?.name}`);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = r + g + b === 0 ? 0 : 255; // transparent no-data
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}
