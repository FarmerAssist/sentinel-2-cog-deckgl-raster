import {
  MosaicLayer,
  MultiCOGLayer,
} from "@developmentseed/deck.gl-geotiff";
import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { epsgResolver } from "@developmentseed/proj";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  useControl,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { fetchStacItems, type PartialSTACItem } from "./stac";
import {
  buildRenderPipeline,
  COMPOSITE,
  DEFAULT_NDVI_COLORMAP,
  DEFAULT_NDVI_RANGE,
  DEFAULT_NDVI_SCALE,
  DEFAULT_RGB_RESCALE_MAX,
  NDVI_COLORMAPS,
  SOURCE_BANDS,
  type NdviColormap,
  type RenderMode,
} from "./renderPipeline";

// Years with CORS-open coverage on data.source.coop. The STAC collection
// advertises 2018–2021 too but those items are hosted on a non-CORS bucket
// (filtered out by stac.ts CORS_OK_HOSTS).
const AVAILABLE_YEARS = [2022, 2023, 2024] as const;
const DEFAULT_YEAR = 2023;
// Amazon — central/southern basin (~749 CORS-open items; Negro, Madeira,
// Purus). Big enough to roam; only zooming fully out to frame all of it at
// once gets heavy (~1500 header opens). The hard cliff is thousands, not this.
const STAC_BBOX: [number, number, number, number] = [-70.0, -10.0, -50.0, 2.0];

function yearToDatetime(year: number): string {
  return `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`;
}

type LoadStats = { loaded: number; failed: number; failures: { url: string; err: string }[] };

function DeckGLOverlay({
  layers,
  onDevice,
}: {
  layers: any[];
  onDevice: (device: Device) => void;
}) {
  const overlay = useControl(
    () =>
      new MapboxOverlay({
        interleaved: true,
        layers,
        onDeviceInitialized: onDevice,
      } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  // Cache MultiCOGLayer `sources` records per (mode, source.id) so the SAME
  // object reference is reused across brightness / colormap changes. MultiCOG
  // checks `props.sources !== oldProps.sources` (multi-cog-layer.ts:309) and
  // resets internal state on any mismatch — i.e. reopens GeoTIFFs and refetches
  // tiles. Passing a fresh object each render was forcing a full refetch on
  // every slider tick.
  const sourcesCache = useRef(new Map<string, Record<string, { url: string }>>());
  const modeGen = useRef(0);
  const prevMode = useRef<RenderMode | null>(null);
  // One AbortController per generation. Aborting on mode switch kills the
  // old mode's in-flight band fetches so they stop hogging the (maxRequests-
  // capped) scheduler — otherwise a backlog of pending NDVI reads can starve
  // the new mode's requests and the switch appears to hang.
  const genAbort = useRef<AbortController | null>(null);
  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  const [stacError, setStacError] = useState<string | null>(null);
  const [mode, setMode] = useState<RenderMode>("rgb");
  const [year, setYear] = useState<number>(DEFAULT_YEAR);
  const [rgbRescaleMax, setRgbRescaleMax] = useState<number>(DEFAULT_RGB_RESCALE_MAX);
  const [ndviColormap, setNdviColormap] = useState<NdviColormap>(DEFAULT_NDVI_COLORMAP);
  const [ndviRange, setNdviRange] = useState<[number, number]>(DEFAULT_NDVI_RANGE);
  const [ndviScale, setNdviScale] = useState<number>(DEFAULT_NDVI_SCALE);
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  const [labels, setLabels] = useState(false);
  const stats: LoadStats = { loaded: 0, failed: 0, failures: [] };

  const mapStyle = labels
    ? "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json";

  // Bump a generation on mode change so the MosaicLayer/MultiCOGLayer ids
  // change, forcing deck.gl to fully unmount the old mode's layer tree
  // instead of leaving stale tile-cache entries that keep rendering + fetching.
  if (prevMode.current !== mode) {
    if (prevMode.current !== null) modeGen.current += 1;
    prevMode.current = mode;
    sourcesCache.current.clear();
    genAbort.current?.abort();
    genAbort.current = new AbortController();
  }
  if (!genAbort.current) genAbort.current = new AbortController();
  const gen = modeGen.current;
  const genSignal = genAbort.current.signal;

  // Load + upload the cividis-bearing colormap sprite once the GPU device exists.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(colormapsPngUrl);
        const bytes = await resp.arrayBuffer();
        const image = await decodeColormapSprite(bytes);
        if (cancelled) return;
        setColormapTexture(createColormapTexture(device, image));
      } catch (err) {
        console.error("[colormap] failed to load sprite:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device]);

  useEffect(() => {
    const ac = new AbortController();
    setStacItems([]);
    setStacError(null);
    fetchStacItems({ datetime: yearToDatetime(year), bbox: STAC_BBOX, signal: ac.signal })
      .then((items) => {
        setStacItems(items);
        console.info(`[stac] ${items.length} items for ${year}`);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[stac] fetch failed:", err);
          setStacError(String(err.message ?? err));
        }
      });
    return () => ac.abort();
  }, [year]);

  const layers = useMemo(() => {
    if (stacItems.length === 0) return [];
    if (mode === "ndvi" && !colormapTexture) return [];

    const bandSlots = SOURCE_BANDS[mode];
    const composite = COMPOSITE[mode];
    const pipeline = buildRenderPipeline(mode, colormapTexture, {
      rgbRescaleMax,
      ndviColormap,
      ndviRange,
      ndviScale,
    });

    const mosaic = new MosaicLayer<PartialSTACItem, null>({
      id: `s2-mosaic-${mode}-${gen}`,
      sources: stacItems,
      // Cache full MultiCOGLayer instances minimally — keeps stale per-mode
      // sublayers from lingering across a mode switch.
      maxCacheSize: 0,
      // MultiCOGLayer fetches its own GeoTIFFs; MosaicLayer only needs each
      // item's bbox (used internally for spatial indexing).
      getSource: async () => null,
      renderSource: (source) => {
        const cacheKey = `${mode}-${source.id}`;
        let sources = sourcesCache.current.get(cacheKey);
        if (!sources) {
          sources = Object.fromEntries(
            Object.entries(bandSlots).map(([slot, bandKey]) => [
              slot,
              { url: source.assets[bandKey].href },
            ]),
          );
          sourcesCache.current.set(cacheKey, sources);
        }
        return new MultiCOGLayer({
          id: `s2-multi-${mode}-${gen}-${source.id}`,
          sources,
          composite,
          renderPipeline: pipeline,
          epsgResolver,
          signal: genSignal,
          // See docs/PERF_KNOBS.md for the full menu + drawbacks.
          refinementStrategy: "best-available",
          maxRequests: 16,
          // NOTE: RGB shows faint tile-edge seams that NDVI's ratio hides.
          // Tested maxError:0.01 (tighter reproject mesh) and
          // refinementStrategy:"no-overlap" (no overview mixing) — neither
          // fixed it. Root cause is the per-item independent tile grids; see
          // docs/SEAMS.md.
          // Inner RasterTileLayer caches each tile's renderPipeline result
          // (raster-tile-layer.ts:338 wires renderTile → renderSubLayers).
          // Without this, brightness/colormap prop changes never reach
          // already-rendered tiles.
          updateTriggers: {
            renderTile: [mode, rgbRescaleMax, ndviColormap, ndviRange[0], ndviRange[1], ndviScale, colormapTexture],
          },
        } as any);
      },
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [stacItems, labelBeforeId, mode, gen, colormapTexture, rgbRescaleMax, ndviColormap, ndviRange, ndviScale]);

  const initialViewState = {
    longitude: -60.0,
    latitude: -4.0,
    zoom: 6,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={3}
        // attributionControl={false}  // comment out to re-enable the (i) badge bottom-right
        attributionControl={false}
        mapStyle={mapStyle}
        onLoad={(e) => {
          const map = e.target;
          const ls = map.getStyle()?.layers ?? [];
          const firstSymbol = ls.find((l: any) => l.type === "symbol");
          setLabelBeforeId(firstSymbol?.id);
          // Re-derive the label insertion point whenever the style reloads
          // (e.g. toggling the labels basemap) so imagery stays under labels.
          map.on("styledata", () => {
            const layers = map.getStyle()?.layers ?? [];
            const sym = layers.find((l: any) => l.type === "symbol");
            setLabelBeforeId(sym?.id);
          });
        }}
      >
        <DeckGLOverlay layers={layers} onDevice={setDevice} />
      </MaplibreMap>
      <InfoPanel
        sourceCount={stacItems.length}
        year={year}
        availableYears={AVAILABLE_YEARS}
        onYearChange={setYear}
        error={stacError}
        stats={stats}
        mode={mode}
        onModeChange={setMode}
        rgbRescaleMax={rgbRescaleMax}
        onRgbRescaleMaxChange={setRgbRescaleMax}
        ndviColormap={ndviColormap}
        onNdviColormapChange={setNdviColormap}
        ndviRange={ndviRange}
        onNdviRangeChange={setNdviRange}
        ndviScale={ndviScale}
        onNdviScaleChange={setNdviScale}
        labels={labels}
        onLabelsChange={setLabels}
      />
    </div>
  );
}

function InfoPanel({
  sourceCount,
  year,
  availableYears,
  onYearChange,
  error,
  stats,
  mode,
  onModeChange,
  rgbRescaleMax,
  onRgbRescaleMaxChange,
  ndviColormap,
  onNdviColormapChange,
  ndviRange,
  onNdviRangeChange,
  ndviScale,
  onNdviScaleChange,
  labels,
  onLabelsChange,
}: {
  sourceCount: number;
  year: number | null;
  availableYears: readonly number[];
  onYearChange: (y: number) => void;
  error: string | null;
  stats: LoadStats;
  mode: RenderMode;
  onModeChange: (m: RenderMode) => void;
  rgbRescaleMax: number;
  onRgbRescaleMaxChange: (v: number) => void;
  ndviColormap: NdviColormap;
  onNdviColormapChange: (c: NdviColormap) => void;
  ndviRange: [number, number];
  onNdviRangeChange: (r: [number, number]) => void;
  ndviScale: number;
  onNdviScaleChange: (s: number) => void;
  labels: boolean;
  onLabelsChange: (v: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = Math.max(0, sourceCount - stats.loaded - stats.failed);
  const copyFailures = () => {
    const text = stats.failures.map((f) => `${f.url}\n  ${f.err}`).join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="expand panel"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          width: 28,
          height: 28,
          padding: 0,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 14,
          lineHeight: "26px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        }}
      >
        ▸
      </button>
    );
  }
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
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
        maxWidth: 480,
        userSelect: "text",
        WebkitUserSelect: "text",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "expand" : "collapse"}
          style={{
            background: "transparent",
            border: "none",
            color: "white",
            cursor: "pointer",
            padding: 0,
            fontSize: 12,
            opacity: 0.7,
            width: 14,
          }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        Sentinel-2 Temporal Mosaic
        <select
          value={year ?? ""}
          onChange={(e) => onYearChange(Number(e.target.value))}
          style={{
            fontSize: 11,
            fontWeight: 500,
            padding: "2px 6px",
            background: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 3,
            color: "white",
            cursor: "pointer",
          }}
        >
          {availableYears.map((y) => (
            <option key={y} value={y} style={{ background: "#222" }}>
              {y}
            </option>
          ))}
        </select>
      </div>

      <div style={{ opacity: 0.65, fontSize: 11, marginTop: 4 }}>
        {error
          ? `STAC error: ${error}`
          : sourceCount === 0
            ? "loading STAC items…"
            : `${sourceCount} sources · ${stats.loaded} loaded · ${stats.failed} failed · ${pending} pending`}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 4 }}>
        {(["rgb", "ndvi"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              borderRadius: 3,
              border: "1px solid rgba(255,255,255,0.3)",
              background:
                mode === m ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.05)",
              color: "white",
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {m === "rgb" ? "RGB (B04/B03/B02)" : "NDVI (cividis)"}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={() => onLabelsChange(!labels)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.3)",
            background: labels ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.05)",
            color: "white",
            cursor: "pointer",
            letterSpacing: 0.5,
          }}
        >
          labels {labels ? "on" : "off"}
        </button>
      </div>
      {mode === "ndvi" && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
            <span>NDVI range</span>
            <span style={{ opacity: 0.6 }}>
              {ndviRange[0].toFixed(2)} → {ndviRange[1].toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={ndviRange[0]}
            onChange={(e) => {
              const v = Number(e.target.value);
              onNdviRangeChange([Math.min(v, ndviRange[1] - 0.05), ndviRange[1]]);
            }}
            style={{ width: "100%", marginTop: 2 }}
          />
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={ndviRange[1]}
            onChange={(e) => {
              const v = Number(e.target.value);
              onNdviRangeChange([ndviRange[0], Math.max(v, ndviRange[0] + 0.05)]);
            }}
            style={{ width: "100%" }}
          />
          <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
            <span>darken</span>
            <span style={{ opacity: 0.6 }}>×{ndviScale.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0.2}
            max={1.5}
            step={0.05}
            value={ndviScale}
            onChange={(e) => onNdviScaleChange(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>
      )}
      {mode === "ndvi" && (
        <div style={{ marginTop: 8, display: "flex", gap: 4 }}>
          {NDVI_COLORMAPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onNdviColormapChange(c)}
              style={{
                padding: "3px 8px",
                fontSize: 10,
                borderRadius: 3,
                border: "1px solid rgba(255,255,255,0.3)",
                background:
                  ndviColormap === c
                    ? "rgba(255,255,255,0.25)"
                    : "rgba(255,255,255,0.05)",
                color: "white",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {mode === "rgb" && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
            <span>brightness</span>
            <span style={{ opacity: 0.6 }}>
              max {rgbRescaleMax.toFixed(3)}
            </span>
          </div>
          {/* Slider value is the LOG of rescaleMax so the perceptual step is even. */}
          <input
            type="range"
            min={-2.5}
            max={-0.7}
            step={0.05}
            value={Math.log10(rgbRescaleMax)}
            onChange={(e) => onRgbRescaleMaxChange(10 ** Number(e.target.value))}
            style={{ width: "100%", marginTop: 2 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.5 }}>
            <span>brighter</span>
            <span>darker</span>
          </div>
        </div>
      )}
      {stats.failures.length > 0 && (
        <details open style={{ marginTop: 6, fontSize: 11 }}>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <span>{stats.failures.length} failed</span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                copyFailures();
              }}
              style={{
                fontSize: 10,
                padding: "2px 6px",
                background: "rgba(255,255,255,0.15)",
                color: "white",
                border: "1px solid rgba(255,255,255,0.3)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              copy all
            </button>
          </summary>
          <ul
            style={{
              margin: "6px 0 0 0",
              paddingLeft: 14,
              maxHeight: 220,
              overflow: "auto",
              userSelect: "text",
              WebkitUserSelect: "text",
            }}
          >
            {stats.failures.map((f, i) => (
              <li key={i} style={{ wordBreak: "break-all", marginBottom: 6 }}>
                <code style={{ fontSize: 10, userSelect: "all", WebkitUserSelect: "all" }}>{f.url}</code>
                <div style={{ opacity: 0.75, marginTop: 2, userSelect: "text", WebkitUserSelect: "text" }}>
                  {f.err}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
