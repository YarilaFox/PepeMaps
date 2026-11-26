export const OVERVIEW_TILE_PIXELS = 384
export const PREVIEW_TILE_PIXELS = 640

const MAX_DETAIL_TILES = 10
const MAX_EFFECTIVE_PIXEL_RATIO = 1.25

export function getMapImageModes({
  tileScreenPixels,
  pixelRatio = 1,
  hasPreviews,
  visibleDetailTiles,
  previewActive,
  detailActive,
  overviewFailed
}) {
  const wantedPixels = tileScreenPixels * Math.min(Math.max(pixelRatio, 1), MAX_EFFECTIVE_PIXEL_RATIO)
  const previewThreshold = OVERVIEW_TILE_PIXELS * (previewActive ? 0.8 : 0.95)
  const detailThreshold = (hasPreviews ? PREVIEW_TILE_PIXELS : OVERVIEW_TILE_PIXELS) * (detailActive ? 0.8 : 0.95)

  return {
    preview: hasPreviews && wantedPixels >= previewThreshold,
    detail: overviewFailed || (visibleDetailTiles <= MAX_DETAIL_TILES && wantedPixels >= detailThreshold)
  }
}
