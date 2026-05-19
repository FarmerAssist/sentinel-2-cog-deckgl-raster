import {
  COGLayer,
  MosaicLayer,
} from "@developmentseed/deck.gl-geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";
import { epsgResolver } from "@developmentseed/proj";
import { MapboxOverlay } from "@deck.gl/mapbox";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  useControl,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { loadGeoTIFF } from "./loadGeotiff";
import { getTileData, type S2TileData } from "./getTileData";
import { renderTile } from "./renderTile";
import { fetchStacItems, type PartialSTACItem } from "./stac";

const STAC_DATETIME = "2024-01-01T00:00:00Z/2024-12-31T23:59:59Z";
const STAC_YEAR = 2024;
const STAC_BBOX: [number, number, number, number] = [95.0, 0.0, 115.0, 25.0];

const geotiffCache = new Map<string, Promise<GeoTIFF>>();

type LoadStats = { loaded: number; failed: number; failures: { url: string; err: string }[] };
const loadStats: LoadStats = { loaded: 0, failed: 0, failures: [] };
type StatsListener = (s: LoadStats) => void;
const statsListeners = new Set<StatsListener>();
function notifyStats() {
  const snap = { loaded: loadStats.loaded, failed: loadStats.failed, failures: [...loadStats.failures] };
  for (const fn of statsListeners) fn(snap);
}

async function loadWithRetry(url: string, attempts = 3): Promise<GeoTIFF> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await loadGeoTIFF(url);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = 300 * 2 ** i + Math.random() * 200;
        console.warn(`[cog] retry ${i + 1}/${attempts - 1} after ${delay | 0}ms: ${url}`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  console.error(`[cog] giving up on ${url}`, lastErr);
  throw lastErr;
}

function getCachedGeoTIFF(url: string): Promise<GeoTIFF> {
  let p = geotiffCache.get(url);
  if (!p) {
    p = loadWithRetry(url).then(
      (tiff) => {
        loadStats.loaded++;
        notifyStats();
        return tiff;
      },
      (err) => {
        loadStats.failed++;
        loadStats.failures.push({ url, err: String(err?.message ?? err) });
        notifyStats();
        geotiffCache.delete(url);
        throw err;
      },
    );
    geotiffCache.set(url, p);
  }
  return p;
}

function DeckGLOverlay({ layers }: { layers: any[] }) {
  const overlay = useControl(
    () => new MapboxOverlay({ interleaved: true, layers } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  const [stacError, setStacError] = useState<string | null>(null);
  const [stats, setStats] = useState<LoadStats>({ loaded: 0, failed: 0, failures: [] });

  useEffect(() => {
    const fn: StatsListener = (s) => setStats(s);
    statsListeners.add(fn);
    return () => {
      statsListeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchStacItems({ datetime: STAC_DATETIME, bbox: STAC_BBOX, signal: ac.signal })
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

  const layers = useMemo(() => {
    if (stacItems.length === 0) return [];
    const mosaic = new MosaicLayer<PartialSTACItem, GeoTIFF>({
      id: "s2-mosaic",
      sources: stacItems,
      getSource: (source) => getCachedGeoTIFF(source.assets.visual.href),
      renderSource: (source, { data, signal }) => {
        if (!data) return null;
        return new COGLayer<S2TileData>({
          id: `s2-cog-${source.id}`,
          geotiff: data,
          epsgResolver,
          getTileData,
          renderTile,
          signal,
        });
      },
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [stacItems, labelBeforeId]);

  const initialViewState = {
    longitude: 106,
    latitude: 14,
    zoom: 4,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={3}
        mapStyle="https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json"
        onLoad={(e) => {
          const map = e.target;
          const ls = map.getStyle()?.layers ?? [];
          const firstSymbol = ls.find((l: any) => l.type === "symbol");
          if (firstSymbol) setLabelBeforeId(firstSymbol.id);
        }}
      >
        <DeckGLOverlay layers={layers} />
      </MaplibreMap>
      <InfoPanel
        sourceCount={stacItems.length}
        year={STAC_YEAR}
        error={stacError}
        stats={stats}
      />
    </div>
  );
}

function InfoPanel({
  sourceCount,
  year,
  error,
  stats,
}: {
  sourceCount: number;
  year: number | null;
  error: string | null;
  stats: LoadStats;
}) {
  const pending = Math.max(0, sourceCount - stats.loaded - stats.failed);
  const copyFailures = () => {
    const text = stats.failures.map((f) => `${f.url}\n  ${f.err}`).join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };
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
            : `${sourceCount} sources · ${stats.loaded} loaded · ${stats.failed} failed · ${pending} pending`}
      </div>
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
