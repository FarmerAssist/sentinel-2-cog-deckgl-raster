#!/usr/bin/env bash
# Diagnose whether a collection's bands share a pixel grid — the test that
# explained the NDBI/NDMI ±1 seams. A normalized-difference index (a−b)/(a+b)
# only works if both bands have the SAME resolution AND extent/origin; if they
# differ, one band zero-pads where the other has data and the ratio snaps to ±1.
#
# Usage: scripts/check_band_grids.sh [ITEM_ID] [BANDS...]
#   ITEM_ID  STAC item id (default: 12SUC_2023-01-01_2024-01-01)
#   BANDS    space-separated band names (default: B04 B08 B11)
# Requires: gdalinfo (GDAL), python3.
#
# Verdict: bands whose size + pixel size + corner coords all match are safe to
# pair; any that differ (e.g. 20m B11 vs 10m B08) will seam.
set -euo pipefail

ITEM="${1:-12SUC_2023-01-01_2024-01-01}"; shift || true
BANDS=("${@:-B04 B08 B11}")
BASE="https://data.source.coop/earthgenome/sentinel2-temporal-mosaics/${ITEM}"

for b in ${BANDS[@]}; do
  echo "===== ${b} ====="
  gdalinfo -json "/vsicurl/${BASE}/${b}.tif" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin); gt = d['geoTransform']; band = d['bands'][0]
print(' size      ', d['size'])
print(' pixel size', round(gt[1], 3), round(gt[5], 3))
print(' corner UL ', [round(x, 1) for x in d['cornerCoordinates']['upperLeft']])
print(' corner LR ', [round(x, 1) for x in d['cornerCoordinates']['lowerRight']])
print(' dtype     ', band.get('type'), '| nodata', band.get('noDataValue'))
"
done

# Observed 2026-05-20 (item 12SUC_2023-01-01_2024-01-01):
#   B04, B08 : 14336x14336, 9.55m, UL -12599268.2, nodata 0   (identical grid)
#   B11      : 7424x7168,  19.11m, UL -12601714.2, nodata 0   (HALF res, shifted)
# => B11 mixed with a 10m band seams. NDVI/NDWI (all 10m) are clean.
