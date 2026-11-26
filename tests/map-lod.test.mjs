import assert from "node:assert/strict"
import test from "node:test"
import { getMapImageModes } from "../src/map-lod.js"

const base = {
  pixelRatio: 1,
  hasPreviews: true,
  visibleDetailTiles: 4,
  previewActive: false,
  detailActive: false,
  overviewFailed: false
}

test("overview stays alone while its pixels are sufficient", () => {
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 250 }), { preview: false, detail: false })
})

test("preview and detail appear as their source resolution is reached", () => {
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 400 }), { preview: true, detail: false })
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 650 }), { preview: true, detail: true })
})

test("full-resolution tiles stay off for broad map views", () => {
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 650, visibleDetailTiles: 16 }), { preview: true, detail: false })
})

test("hysteresis prevents a small zoom change from removing detail", () => {
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 550, previewActive: true, detailActive: true }), { preview: true, detail: true })
})

test("high density screens promote quality without an unbounded pixel multiplier", () => {
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 500, pixelRatio: 2 }), { preview: true, detail: true })
  assert.deepEqual(getMapImageModes({ ...base, tileScreenPixels: 250, pixelRatio: 4 }), { preview: false, detail: false })
})
