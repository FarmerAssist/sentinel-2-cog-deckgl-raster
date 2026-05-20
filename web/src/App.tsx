import {
  COGLayer,
  MosaicLayer,
  MultiCOGLayer,
} from "@developmentseed/deck.gl-geotiff";
import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { epsgResolver } from "@developmentseed/proj";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  Marker,
  useControl,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { fetchStacItems, type PartialSTACItem } from "./stac";
import {
  reportFailed,
  reportLoaded,
  resetStats,
  subscribeStats,
  type StatsSnapshot,
} from "./loadStats";
import { resultToBbox, type GeoResult } from "./geocode";
import { PlaceSearch } from "./PlaceSearch";
import { loadGeoTIFF } from "./loadGeotiff";
import { getTileData, type S2TileData } from "./getTileData";
import { renderTile } from "./renderTile";
import {
  bandSlotsFor,
  buildRenderPipeline,
  DEFAULT_NDVI_COLORMAP,
  DEFAULT_NDVI_RANGE,
  DEFAULT_NDVI_SCALE,
  INDEX_COMPOSITE,
  INDICES,
  INDEX_KEYS,
  isIndexMode,
  NDVI_COLORMAPS,
  type NdviColormap,
  type RenderMode,
} from "./renderPipeline";

// RGB renders the precomposed 8-bit TCI COG via COGLayer; brightness is a
// uniform ScaleColor gain (1.0 = faithful TCI), not a raw-band rescale.
const DEFAULT_RGB_GAIN = 1.0;

/**
 * Module-level cache of opened TCI GeoTIFFs keyed by URL (mirrors the
 * deck.gl-raster naip-mosaic example). Header reads are small; the GeoTIFF
 * instance is reused for the app's lifetime and shared across concurrent
 * callers via the cached promise. Kept outside MosaicLayer's TileLayer cache
 * so cheap header metadata isn't pinned to parent-tile lifetime. Uses our
 * loadGeoTIFF wrapper for the chunkd HEAD-size workaround. Evicts on rejection.
 */
const geotiffCache = new Map<string, Promise<GeoTIFF>>();
function getCachedGeoTIFF(url: string): Promise<GeoTIFF> {
  let p = geotiffCache.get(url);
  if (!p) {
    p = loadGeoTIFF(url).catch((err) => {
      geotiffCache.delete(url);
      throw err;
    });
    geotiffCache.set(url, p);
  }
  return p;
}

// Years with CORS-open coverage on data.source.coop. The STAC collection
// advertises 2018–2021 too but those items are hosted on a non-CORS bucket
// (filtered out by stac.ts CORS_OK_HOSTS).
const AVAILABLE_YEARS = [2022, 2023, 2024] as const;
const DEFAULT_YEAR = 2023;
// Yuma, AZ + margin (lower Colorado River irrigated ag vs Sonoran desert;
// ~32 CORS-open items in 2023)
const STAC_BBOX: [number, number, number, number] = [-115.5, 31.5, -113.0, 33.5];

// Items are ANNUAL composites (`YYYY-01-01_YYYY+1-01-01`). A full-year query
// also matches the adjacent years' annuals at the Jan-1 boundary, so a tile can
// come back as two overlapping composites. We KEEP that overlap on purpose: a
// no-data hole (cloud) in one year's composite can be backfilled by the other
// through the mosaic (discardBlack lets the lower layer show through). Deduping
// would maximize speed but risk losing coverage.
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
  const [rgbGain, setRgbGain] = useState<number>(DEFAULT_RGB_GAIN);
  const [ndviColormap, setNdviColormap] = useState<NdviColormap>(DEFAULT_NDVI_COLORMAP);
  const [ndviRange, setNdviRange] = useState<[number, number]>(DEFAULT_NDVI_RANGE);
  const [ndviScale, setNdviScale] = useState<number>(DEFAULT_NDVI_SCALE);
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  const [labels, setLabels] = useState(false);
  const [bbox, setBbox] = useState<[number, number, number, number]>(STAC_BBOX);
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [showMarker, setShowMarker] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const [stats, setStats] = useState<LoadStats>({ loaded: 0, failed: 0, failures: [] });

  // Mirror the module-level load scoreboard into React state.
  useEffect(() => subscribeStats(setStats), []);

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

  // Fresh scoreboard whenever the source set changes (AOI / year) or the render
  // mode switches — stale per-AOI counts would otherwise carry over.
  useEffect(() => resetStats(), [bbox, year, mode]);

  useEffect(() => {
    const ac = new AbortController();
    setStacItems([]);
    setStacError(null);
    // Debounce: rapid bbox changes (draw-tool drags, repeated searches) would
    // otherwise kick off overlapping /search paginations against the public
    // STAC API. Wait for the AOI to settle before fetching.
    const t = setTimeout(() => {
      fetchStacItems({ datetime: yearToDatetime(year), bbox, signal: ac.signal })
        .then(({ items, rejected }) => {
          setStacItems(items);
          console.info(`[stac] ${items.length} items for ${year} (${rejected} CORS-blocked)`);
          if (items.length === 0) {
            setStacError(
              rejected > 0
                ? `No CORS-open imagery here — ${rejected} item${rejected > 1 ? "s" : ""} exist but are on a CORS-blocked host. Try the Americas or Europe.`
                : "No imagery for this area/year.",
            );
          }
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[stac] fetch failed:", err);
            setStacError(String(err.message ?? err));
          }
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [year, bbox]);

  // Box drawn on the map (item 5): the [W,S,E,N] becomes the new STAC AOI,
  // mirroring lonboard's `selected_bounds`. Drops a marker at the box center.
  const handleDrawBox = (bb: [number, number, number, number]) => {
    setBbox(bb);
    setMarker({ lng: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2, label: "drawn AOI" });
    setShowMarker(true);
    setDrawing(false);
  };

  const handlePickPlace = (r: GeoResult) => {
    const bb = resultToBbox(r);
    setBbox(bb);
    setMarker({ lng: r.center[0], lat: r.center[1], label: r.label });
    setShowMarker(true);
    mapRef.current?.fitBounds(
      [
        [bb[0], bb[1]],
        [bb[2], bb[3]],
      ],
      { padding: 40, duration: 1000 },
    );
  };

  const layers = useMemo(() => {
    if (stacItems.length === 0) return [];

    // RGB: render the single precomposed 3-band TCI COG per item through
    // COGLayer (the deck.gl-raster naip-mosaic pattern). One COG per item, so
    // no cross-band-file misregistration — this is what kills the seams that
    // the old MultiCOGLayer (separate B04/B03/B02 files) produced. See
    // docs/SEAMS.md.
    if (mode === "rgb") {
      const mosaic = new MosaicLayer<PartialSTACItem, GeoTIFF>({
        id: `s2-mosaic-rgb-${gen}`,
        sources: stacItems,
        maxCacheSize: 0,
        getSource: (source) => {
          const url = source.assets.visual.href;
          return getCachedGeoTIFF(url).then(
            (g) => {
              reportLoaded(url);
              return g;
            },
            (e) => {
              reportFailed(url, e instanceof Error ? e.message : String(e));
              throw e;
            },
          );
        },
        renderSource: (source, { data }) =>
          new COGLayer<S2TileData>({
            id: `s2-cog-rgb-${gen}-${source.id}`,
            geotiff: data,
            epsgResolver,
            getTileData,
            renderTile: (tileData: S2TileData) => renderTile(tileData, rgbGain),
            signal: genSignal,
            refinementStrategy: "best-available",
            maxRequests: 16,
            // ScaleColor gain is closed over rgbGain; retrigger the cached
            // per-tile renderPipeline when it changes.
            updateTriggers: { renderTile: [rgbGain] },
          } as any),
        // @ts-expect-error beforeId is injected by @deck.gl/mapbox
        beforeId: labelBeforeId,
      });
      return [mosaic];
    }

    // Spectral indices: need a 2-band ratio, so keep the MultiCOGLayer composite
    // path. Normalized-difference indices are seam-free (the ratio cancels
    // per-edge brightness offsets).
    if (!colormapTexture) return [];

    const bandSlots = bandSlotsFor(mode);
    const composite = INDEX_COMPOSITE;
    const pipeline = buildRenderPipeline(mode, colormapTexture, {
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
          // Inner RasterTileLayer caches each tile's renderPipeline result
          // (raster-tile-layer.ts:338 wires renderTile → renderSubLayers).
          // Without this, colormap prop changes never reach already-rendered
          // tiles.
          updateTriggers: {
            renderTile: [mode, ndviColormap, ndviRange[0], ndviRange[1], ndviScale, colormapTexture],
          },
        } as any);
      },
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [stacItems, labelBeforeId, mode, gen, colormapTexture, rgbGain, ndviColormap, ndviRange, ndviScale]);

  const initialViewState = {
    longitude: -114.6,
    latitude: 32.7,
    zoom: 9,
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
        <DrawBbox mapRef={mapRef} active={drawing} onComplete={handleDrawBox} />
        {marker && showMarker && (
          <Marker longitude={marker.lng} latitude={marker.lat} anchor="bottom">
            <div
              title={marker.label}
              style={{
                width: 14,
                height: 14,
                borderRadius: "50% 50% 50% 0",
                transform: "rotate(-45deg)",
                background: "#ff4d4f",
                border: "2px solid white",
                boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
              }}
            />
          </Marker>
        )}
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
        rgbGain={rgbGain}
        onRgbGainChange={setRgbGain}
        ndviColormap={ndviColormap}
        onNdviColormapChange={setNdviColormap}
        ndviRange={ndviRange}
        onNdviRangeChange={setNdviRange}
        ndviScale={ndviScale}
        onNdviScaleChange={setNdviScale}
        labels={labels}
        onLabelsChange={setLabels}
        onPickPlace={handlePickPlace}
        hasMarker={marker !== null}
        showMarker={showMarker}
        onToggleMarker={() => setShowMarker((v) => !v)}
        drawing={drawing}
        onToggleDraw={() => setDrawing((v) => !v)}
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
  rgbGain,
  onRgbGainChange,
  ndviColormap,
  onNdviColormapChange,
  ndviRange,
  onNdviRangeChange,
  ndviScale,
  onNdviScaleChange,
  labels,
  onLabelsChange,
  onPickPlace,
  hasMarker,
  showMarker,
  onToggleMarker,
  drawing,
  onToggleDraw,
}: {
  sourceCount: number;
  year: number | null;
  availableYears: readonly number[];
  onYearChange: (y: number) => void;
  error: string | null;
  stats: LoadStats;
  mode: RenderMode;
  onModeChange: (m: RenderMode) => void;
  rgbGain: number;
  onRgbGainChange: (v: number) => void;
  ndviColormap: NdviColormap;
  onNdviColormapChange: (c: NdviColormap) => void;
  ndviRange: [number, number];
  onNdviRangeChange: (r: [number, number]) => void;
  ndviScale: number;
  onNdviScaleChange: (s: number) => void;
  labels: boolean;
  onLabelsChange: (v: boolean) => void;
  onPickPlace: (r: GeoResult) => void;
  hasMarker: boolean;
  showMarker: boolean;
  onToggleMarker: () => void;
  drawing: boolean;
  onToggleDraw: () => void;
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

      <PlaceSearch onPick={onPickPlace} />

      <div style={{ opacity: 0.65, fontSize: 11, marginTop: 4 }}>
        {error
          ? `STAC error: ${error}`
          : sourceCount === 0
            ? "loading STAC items…"
            : `${sourceCount} sources · ${stats.loaded} loaded · ${stats.failed} failed · ${pending} pending`}
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => onModeChange("rgb")}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.3)",
            background: mode === "rgb" ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.05)",
            color: "white",
            cursor: "pointer",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          RGB (TCI)
        </button>
        <span style={{ opacity: 0.4, fontSize: 11 }}>or index</span>
        <select
          value={isIndexMode(mode) ? mode : ""}
          onChange={(e) => onModeChange(e.target.value as RenderMode)}
          style={{
            fontSize: 11,
            padding: "3px 6px",
            background: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 3,
            color: "white",
            cursor: "pointer",
          }}
        >
          <option value="" disabled style={{ background: "#222" }}>
            choose…
          </option>
          {INDEX_KEYS.map((k) => (
            <option key={k} value={k} style={{ background: "#222" }}>
              {INDICES[k].label} · {INDICES[k].desc}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 4 }}>
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
        <button
          type="button"
          onClick={onToggleDraw}
          title="Drag a rectangle on the map to set the area of interest"
          style={{
            padding: "4px 10px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.3)",
            background: drawing ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.05)",
            color: "white",
            cursor: "pointer",
            letterSpacing: 0.5,
          }}
        >
          {drawing ? "draw: drag a box…" : "draw AOI"}
        </button>
        {hasMarker && (
          <button
            type="button"
            onClick={onToggleMarker}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              borderRadius: 3,
              border: "1px solid rgba(255,255,255,0.3)",
              background: showMarker ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.05)",
              color: "white",
              cursor: "pointer",
              letterSpacing: 0.5,
            }}
          >
            marker {showMarker ? "on" : "off"}
          </button>
        )}
      </div>
      {isIndexMode(mode) && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
            <span>index range</span>
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
            onDoubleClick={() => onNdviRangeChange([DEFAULT_NDVI_RANGE[0], ndviRange[1]])}
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
            onDoubleClick={() => onNdviRangeChange([ndviRange[0], DEFAULT_NDVI_RANGE[1]])}
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
            onDoubleClick={() => onNdviScaleChange(DEFAULT_NDVI_SCALE)}
            style={{ width: "100%" }}
          />
        </div>
      )}
      {isIndexMode(mode) && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
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
      {isIndexMode(mode) && (
        <div style={{ marginTop: 6, fontSize: 10, opacity: 0.45 }}>
          Indices use Earth Genome's public Sentinel-2 bands. Productionizing
          against Satellogic imagery needs their band/asset conventions + auth.
        </div>
      )}
      {mode === "rgb" && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
            <span>brightness</span>
            <span style={{ opacity: 0.6 }}>×{rgbGain.toFixed(2)}</span>
          </div>
          {/* Uniform RGB gain on the TCI texture (1.0 = faithful). */}
          <input
            type="range"
            min={0.4}
            max={2.5}
            step={0.05}
            value={rgbGain}
            onChange={(e) => onRgbGainChange(Number(e.target.value))}
            onDoubleClick={() => onRgbGainChange(DEFAULT_RGB_GAIN)}
            style={{ width: "100%", marginTop: 2 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.5 }}>
            <span>darker</span>
            <span>brighter</span>
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
      <div style={{ marginTop: 8, fontSize: 10, opacity: 0.4 }}>
        Tiles stale or blank? Hard-reload (⌘⇧R / Ctrl+Shift+R).
      </div>
    </div>
  );
}

/**
 * Drag-to-draw an AOI rectangle on the map (item 5; lonboard `selected_bounds`
 * pattern). While `active`, map panning is disabled and a mousedown→drag→mouseup
 * gesture captures two corners. maplibre hands us `e.lngLat` directly, so we
 * build the [W,S,E,N] box from the two corner lng/lats — no unproject needed.
 * A rubber-band div tracks the drag in screen space. Tiny boxes (a stray click)
 * are ignored.
 */
function DrawBbox({
  mapRef,
  active,
  onComplete,
}: {
  mapRef: React.RefObject<MapRef | null>;
  active: boolean;
  onComplete: (bbox: [number, number, number, number]) => void;
}) {
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    map.dragPan.disable();
    map.getCanvas().style.cursor = "crosshair";
    let start: { x: number; y: number; lng: number; lat: number } | null = null;

    const down = (e: any) => {
      start = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
      setRect({ x0: e.point.x, y0: e.point.y, x1: e.point.x, y1: e.point.y });
    };
    const move = (e: any) => {
      if (!start) return;
      setRect((r) => (r ? { ...r, x1: e.point.x, y1: e.point.y } : r));
    };
    const up = (e: any) => {
      if (!start) return;
      const w = Math.min(start.lng, e.lngLat.lng);
      const east = Math.max(start.lng, e.lngLat.lng);
      const s = Math.min(start.lat, e.lngLat.lat);
      const n = Math.max(start.lat, e.lngLat.lat);
      start = null;
      setRect(null);
      if (east - w > 1e-4 && n - s > 1e-4) onComplete([w, s, east, n]);
    };

    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => {
      map.off("mousedown", down);
      map.off("mousemove", move);
      map.off("mouseup", up);
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    };
  }, [active, mapRef, onComplete]);

  if (!rect) return null;
  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const width = Math.abs(rect.x1 - rect.x0);
  const height = Math.abs(rect.y1 - rect.y0);
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        border: "1.5px dashed #ff4d4f",
        background: "rgba(255,77,79,0.12)",
        pointerEvents: "none",
        zIndex: 5,
      }}
    />
  );
}

