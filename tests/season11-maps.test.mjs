import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import sharp from "sharp"
import { OVERVIEW_TILE_PIXELS, PREVIEW_TILE_PIXELS } from "../src/map-lod.js"

const publicDir = path.resolve("public")
const catalog = JSON.parse(await readFile(path.join(publicDir, "maps/catalog.json"), "utf8"))

for (const [worldId, tileCount, minX, minZ, size] of [
  ["build_1", 16, -2048, -2048, 4096],
  ["trade", 9, -1536, -1536, 3072]
]) {
  test(`${worldId} season 11 overworld has complete, full-resolution tiles`, async () => {
    const world = catalog.worlds.find((item) => item.id === worldId)
    assert.ok(world)
    assert.equal(world.manifestPath, `/maps/${worldId}/season11/manifest.json`)
    const manifest = JSON.parse(await readFile(path.join(publicDir, world.manifestPath.slice(1)), "utf8"))
    assert.equal(manifest.tiles.length, tileCount)
    assert.deepEqual(manifest.bounds, { minX, minZ, width: size, height: size })

    const coordinates = new Set()
    for (const tile of manifest.tiles) {
      const file = path.join(publicDir, tile.srcPng.slice(1))
      const metadata = await sharp(file).metadata()
      assert.equal(metadata.width, 1024)
      assert.equal(metadata.height, 1024)
      coordinates.add(`${tile.x},${tile.z}`)
    }
    assert.equal(coordinates.size, tileCount)
    const overviewFile = path.join(publicDir, world.manifestPath.replace(/manifest\.json$/, "overview.webp").slice(1))
    const overview = await sharp(overviewFile).metadata()
    assert.equal(overview.width, size / 1024 * OVERVIEW_TILE_PIXELS)
    assert.equal(overview.height, size / 1024 * OVERVIEW_TILE_PIXELS)

    const previewsFile = path.join(publicDir, world.manifestPath.replace(/manifest\.json$/, "previews.json").slice(1))
    const previews = JSON.parse(await readFile(previewsFile, "utf8"))
    assert.match(previews.assetVersion, /^\d+$/)
    for (const preview of previews.tiles) {
      const previewFile = path.join(publicDir, preview.src.slice(1))
      await stat(previewFile)
      const metadata = await sharp(previewFile).metadata()
      assert.equal(metadata.width, preview.width / 1024 * PREVIEW_TILE_PIXELS)
      assert.equal(metadata.height, preview.height / 1024 * PREVIEW_TILE_PIXELS)
    }
  })
}

test("trade correction changes only the masked area of the central tile", async () => {
  const root = path.join(publicDir, "maps/trade/season11")
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"))
  const tile = manifest.tiles.find(({ x, z }) => x === -512 && z === -512)
  assert.equal(tile.src, tile.srcPng)
  const rgb = (file) => sharp(file).removeAlpha().raw().toBuffer()
  const [original, corrected, mask] = await Promise.all([
    rgb(path.join(root, "tiles/overworld/1_1_x-512_z-512.png")),
    rgb(path.join(publicDir, tile.srcPng.slice(1))),
    sharp(path.resolve("map-corrections/trade-season11/x-64_z-64.png"))
      .removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ])
  const maskSize = 64
  const offset = -64 - tile.x
  const stride = manifest.tileSize * 3
  assert.equal(tile.x, tile.z)
  assert.deepEqual([mask.info.width, mask.info.height, mask.info.channels], [maskSize, maskSize, 3])
  assert.ok(!original.equals(corrected))
  for (let row = 0; row < manifest.tileSize; row++) {
    const start = row * stride
    const end = start + stride
    if (row < offset || row >= offset + maskSize) {
      assert.ok(corrected.subarray(start, end).equals(original.subarray(start, end)), `row ${row}`)
      continue
    }
    const left = start + offset * 3
    const right = left + maskSize * 3
    const maskStart = (row - offset) * maskSize * 3
    assert.ok(corrected.subarray(start, left).equals(original.subarray(start, left)), `left of mask, row ${row}`)
    assert.ok(corrected.subarray(right, end).equals(original.subarray(right, end)), `right of mask, row ${row}`)
    assert.ok(corrected.subarray(left, right).equals(mask.data.subarray(maskStart, maskStart + maskSize * 3)), `mask row ${row}`)
  }
})

test("Nether and End are unavailable in every world", () => {
  for (const world of catalog.worlds) {
    for (const dimension of world.dimensions) {
      if (dimension.id === "nether" || dimension.id === "end") {
        assert.equal(dimension.enabled, false, `${world.id}/${dimension.id}`)
      }
    }
  }
})

test("only MP1 and trade are available in season 11", () => {
  assert.equal(catalog.defaultWorldId, "build_1")
  assert.deepEqual(
    catalog.worlds.filter((world) => world.status === "active").map((world) => world.id),
    ["build_1", "trade"]
  )
  assert.ok(catalog.worlds.every((world) => world.dimensions.every((dimension) => dimension.id !== "pale")))
})

test("contributor heads are local images", async () => {
  assert.deepEqual(catalog.contributors.map((contributor) => contributor.name), ["YarilaFox", "Bratik17078", "haaampter", "green_and_white"])
  for (const contributor of catalog.contributors) {
    const metadata = await sharp(path.join(publicDir, contributor.avatar.slice(1))).metadata()
    assert.equal(metadata.width, 128)
    assert.equal(metadata.height, 128)
  }
})

test("contributor badges match the requested roles", () => {
  assert.deepEqual(catalog.contributors.map(({ name, badge }) => [name, badge]), [
    ["YarilaFox", "crown"],
    ["Bratik17078", "pepemaps"],
    ["haaampter", "marker"],
    ["green_and_white", "pepemaps"]
  ])
})
