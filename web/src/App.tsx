import {
  COGLayer,
  MosaicLayer,
  type GetTileDataOptions,
} from "@developmentseed/deck.gl-geotiff";
import type {
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Overview } from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  useControl,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { fetchStacItems, type PartialSTACItem } from "./stac";

const STAC_DATETIME = "2024-01-01T00:00:00Z/2024-12-31T23:59:59Z";
const STAC_YEAR = 2024;

type TextureDataT = {
  width: number;
  height: number;
  texture: Texture;
};

const geotiffCache = new Map<string, Promise<GeoTIFF>>();

function getCachedGeoTIFF(url: string, signal?: AbortSignal): Promise<GeoTIFF> {
  let p = geotiffCache.get(url);
  if (!p) {
    p = GeoTIFF.fromUrl(url, { signal }).catch((err) => {
      geotiffCache.delete(url);
      throw err;
    });
    geotiffCache.set(url, p);
  }
  return p;
}

/**
 * Sentinel-2 TCI (true-color image) is 3-band uint8 RGB. WebGPU sampled
 * textures need 4-channel formats, so pad to rgba8unorm with alpha=255 and
 * let the shader discard fully-black no-data pixels.
 */
function padRgbToRgba(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

async function getTileData(
  image: GeoTIFF | Overview,
  options: GetTileDataOptions,
): Promise<TextureDataT> {
  const { device, x, y, signal } = options;
  const tile = await image.fetchTile(x, y, { signal, boundless: false });
  const { array } = tile;
  const { width, height } = array;

  let rgba: Uint8Array;
  if (array.layout === "band-separate") {
    const [r, g, b] = array.bands as Uint8Array[];
    rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < r.length; i++, j += 4) {
      rgba[j] = r[i];
      rgba[j + 1] = g[i];
      rgba[j + 2] = b[i];
      rgba[j + 3] = 255;
    }
  } else {
    const data = array.data as Uint8Array;
    if (data.length === width * height * 4) {
      rgba = data;
    } else if (data.length === width * height * 3) {
      rgba = padRgbToRgba(data, width, height);
    } else {
      throw new Error(
        `Unexpected TCI tile size: ${data.length} for ${width}x${height}`,
      );
    }
  }

  const texture = device.createTexture({
    data: rgba,
    format: "rgba8unorm",
    width,
    height,
  });

  return { texture, width, height };
}

/** Drop fully-black pixels (Sentinel-2 cloud/no-data fill). */
const discardBlack = {
  name: "discard-black",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.01) discard;
    `,
  },
} as const satisfies ShaderModule;

function makeRenderTile() {
  return function renderTile(tileData: TextureDataT): RenderTileResult {
    const renderPipeline: RasterModule[] = [
      { module: CreateTexture, props: { textureName: tileData.texture } },
      { module: discardBlack, props: {} },
    ];
    return { renderPipeline };
  };
}

function DeckGLOverlay({
  layers,
  onDeviceInitialized,
}: {
  layers: any[];
  onDeviceInitialized?: (device: Device) => void;
}) {
  const overlay = useControl(
    () =>
      new MapboxOverlay({
        interleaved: true,
        layers,
        onDeviceInitialized,
      } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [, setDevice] = useState<Device | null>(null);
  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  const [stacError, setStacError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchStacItems({ datetime: STAC_DATETIME, signal: ac.signal })
      .then((items) => {
        setStacItems(items);
        console.info(`[stac] ${items.length} items for ${STAC_YEAR}`);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[stac] fetch failed:", err);
          setStacError(String(err.message ?? err));
        }
      });
    return () => ac.abort();
  }, []);

  const renderTile = useMemo(() => makeRenderTile(), []);

  const layers = useMemo(() => {
    if (stacItems.length === 0) return [];
    const mosaic = new MosaicLayer<PartialSTACItem, GeoTIFF>({
      id: "s2-mosaic",
      sources: stacItems,
      getSource: (source, { signal }) =>
        getCachedGeoTIFF(source.assets.visual.href, signal),
      renderSource: (source, { data, signal }) =>
        new COGLayer<TextureDataT>({
          id: `s2-cog-${source.id}`,
          geotiff: data,
          getTileData,
          renderTile,
          signal,
        }),
      maxCacheSize: 0,
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [renderTile, stacItems, labelBeforeId]);

  const initialViewState = {
    longitude: 0,
    latitude: 20,
    zoom: 2,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={1}
        mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
        onLoad={(e) => {
          const map = e.target;
          const ls = map.getStyle()?.layers ?? [];
          const firstSymbol = ls.find((l: any) => l.type === "symbol");
          if (firstSymbol) setLabelBeforeId(firstSymbol.id);
        }}
      >
        <DeckGLOverlay layers={layers} onDeviceInitialized={setDevice} />
      </MaplibreMap>
      <InfoPanel
        sourceCount={stacItems.length}
        year={STAC_YEAR}
        error={stacError}
      />
    </div>
  );
}

function InfoPanel({
  sourceCount,
  year,
  error,
}: {
  sourceCount: number;
  year: number | null;
  error: string | null;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        padding: "10px 14px",
        background: "rgba(0,0,0,0.78)",
        color: "white",
        fontSize: 12,
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        Sentinel-2 Temporal Mosaic
        {year != null && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              fontWeight: 500,
              padding: "2px 6px",
              background: "rgba(255,255,255,0.12)",
              borderRadius: 3,
              verticalAlign: "middle",
            }}
          >
            {year}
          </span>
        )}
      </div>
      <div style={{ opacity: 0.65, fontSize: 11, marginTop: 4 }}>
        {error
          ? `STAC error: ${error}`
          : sourceCount === 0
            ? "loading STAC items…"
            : `${sourceCount} source COGs · earthgenome / source.coop`}
      </div>
    </div>
  );
}
