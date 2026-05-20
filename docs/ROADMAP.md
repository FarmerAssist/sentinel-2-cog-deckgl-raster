# Roadmap / TODO

## Done

- **RGB seams fixed (2026-05-20).** RGB renders the single TCI COG per item via
  `COGLayer` (naip-mosaic pattern); see `docs/SEAMS.md` → "RESOLVED". The
  BitmapLayer overview mode + zoom-gate were dropped (looked worse, still
  seamed). Brightness is now a uniform `ScaleColor` gain on the TCI texture.

## TODO: natural-language place loader ("LLM geocode + marker")

Goal: type a place ("Yuma with margin", "the Mato Grosso soy frontier") and
have the app fly there, set `STAC_BBOX`, and load the tiles — instead of
hand-editing `STAC_BBOX` / `initialViewState` in `App.tsx`.

### Shape

1. **Text box** in the panel.
2. **Resolve text → bbox + center.** Two ways, in order of reliability:
   - **Geocoder API** (Nominatim / Mapbox / Photon) — deterministic, free-ish,
     returns a real bbox. Best for plain place names.
   - **Small LLM** — better for *fuzzy/relative* queries the geocoder can't
     parse ("the soy frontier", "downstream of the confluence", "+200 km
     buffer"). Have it emit structured JSON `{ center:[lng,lat], bbox:[w,s,e,n],
     label }`. LLMs are decent at well-known coords; for precision, let the LLM
     extract a place name + modifiers, then hand the name to the geocoder and
     apply the buffer/margin itself.
   - **Recommendation:** geocoder as the workhorse, LLM only as the fuzzy
     front-end that normalizes the query into `{place, bufferKm}`. Don't trust
     an LLM for raw coordinates when a geocoder is one call away.
3. **Drop a marker** at the resolved center (deck `IconLayer`/`ScatterplotLayer`
   or a maplibre Marker), with a **toggle** to show/hide it. Label = the query.
4. **Load the tiles.** Set `STAC_BBOX` from the resolved bbox and refetch.

### "Load >=100 tiles at a time"

The current eager-load path melts past ~1000 items and grinds in the hundreds
(see `docs/SEAMS.md` connection-pool note, `docs/PERF_KNOBS.md`). The main
enabler for big-AOI loads:

- **Viewport-driven STAC fetch.** Stop enumerating the whole bbox up front;
  query items near the view on `moveend` (debounced) and diff the source list.
  Long-standing TODO (noted in CLAUDE.md). The COGLayer/MosaicLayer path already
  only streams tiles for visible items, so this caps how many sources are open
  at once.

### Suggested build order

1. Geocoder text box + toggleable marker.
2. LLM front-end for fuzzy queries (optional, last).
3. Viewport-driven STAC fetch for true large-area roaming.
