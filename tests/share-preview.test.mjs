import assert from "node:assert/strict"
import test from "node:test"
import sharp from "sharp"
import { getPreviewBucket, loadShareContext, parseShareRequest, renderShareHtml, renderShareImage } from "../lib/share-preview.js"

test("nearby coordinates reuse the same preview bucket", () => {
  assert.deepEqual(getPreviewBucket(80, -620), { x: 128, z: -640 })
  assert.deepEqual(getPreviewBucket(90, -600), { x: 128, z: -640 })
  assert.notDeepEqual(getPreviewBucket(260, -620), getPreviewBucket(80, -620))
})

test("share route rejects invalid coordinates and ids", () => {
  assert.deepEqual(parseShareRequest({ world: "build_1", dimension: "end", x: "0", z: "-5" }), {
    worldId: "build_1", dimensionId: "end", x: 0, z: -5
  })
  assert.equal(parseShareRequest({ world: "../admin", dimension: "end", x: "0", z: "0" }), null)
  assert.equal(parseShareRequest({ world: "build_1", dimension: "end", x: "NaN", z: "0" }), null)
})

test("Vercel loads manifests from the public host, not its deployment alias", async () => {
  const previousFetch = globalThis.fetch
  const previousVercelUrl = process.env.VERCEL_URL
  const fetched = []
  process.env.VERCEL_URL = "protected-preview.vercel.app"
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    const payload = String(url).endsWith("catalog.json")
      ? { worlds: [{ id: "build_1", status: "active", manifestPath: "/maps/build_1/manifest.json", dimensions: [{ id: "overworld", enabled: true }] }] }
      : { bounds: { minX: 0, minZ: 0, width: 1024, height: 1024 }, tileSize: 1024, tiles: [] }
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
  }

  try {
    const context = await loadShareContext(
      { world: "build_1", dimension: "overworld", x: "0", z: "0" },
      { headers: { host: "maps.foxes.my" } }
    )
    assert.equal(context.assetOrigin, "https://maps.foxes.my")
    assert.deepEqual(fetched, [
      "https://maps.foxes.my/maps/catalog.json",
      "https://maps.foxes.my/maps/build_1/manifest.json"
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousVercelUrl === undefined) delete process.env.VERCEL_URL
    else process.env.VERCEL_URL = previousVercelUrl
  }
})

test("share context rejects an HTML response instead of parsing it as JSON", async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("<!doctype html>", {
    headers: { "content-type": "text/html" }
  })

  try {
    await assert.rejects(
      loadShareContext(
        { world: "build_1", dimension: "overworld", x: "-69", z: "12" },
        { headers: { host: "maps.foxes.my" } }
      ),
      /did not return JSON/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("HTML exposes Discord JSON and rectangular image before browser redirect", () => {
  const context = {
    worldId: "build_1", dimensionId: "overworld", x: 80, z: -620,
    world: { shortLabel: "МП1" }, dimension: { label: "Верхний" },
    manifest: { generatedAt: "2026-10-05T12:00:00Z" }
  }
  const html = renderShareHtml({ headers: { host: "maps.foxes.my" }, query: {} }, context)
  const match = html.match(/<script id="discord:component-embed"[^>]*>(.*?)<\/script>/)
  assert.ok(match)
  const embed = JSON.parse(match[1])
  assert.equal(embed.component.type, 17)
  assert.match(embed.component.components[0].content, /^### \[PepeMaps/)
  assert.equal(embed.component.components[1].items[0].media.url.includes("x=128&z=-640"), true)
  assert.match(embed.component.components[0].content, /PepeLand/)
  assert.match(embed.component.components[2].content, /YarilaFox/)
  assert.match(html, /og:image:width" content="1200"/)
  assert.match(html, /og:image:height" content="630"/)
  assert.match(html, /window.location.replace\("https:\/\/maps.foxes.my\/build_1\?dimension=overworld&x=80&z=-620"\)/)
})

test("tile crop fills the full non-square JPEG", async () => {
  const tile = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#e00000" }
  }).png().toBuffer()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(tile, { headers: { "content-type": "image/png" } })

  try {
    const image = await renderShareImage({
      worldId: "build_1", dimensionId: "overworld", x: 100, z: 100,
      manifest: {
        tileSize: 1024,
        bounds: { minX: 0, minZ: 0, width: 1024, height: 1024 },
        tiles: [{ x: 0, z: 0, src: "/maps/build_1/tiles/overworld/test.png" }]
      }
    })
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 1200)
    assert.equal(info.height, 630)
    const lastPixel = data.subarray((info.width * info.height - 1) * info.channels)
    assert.ok(lastPixel[0] > 190 && lastPixel[1] < 40 && lastPixel[2] < 40)
  } finally {
    globalThis.fetch = previousFetch
  }
})
