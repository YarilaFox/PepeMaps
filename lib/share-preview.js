import sharp from "sharp"

const BUCKET_SIZE = 256
const CROP_WIDTH = 1024
const CROP_HEIGHT = 538
const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 630
const MAX_COORDINATE = 30000000

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function readCoordinate(value) {
  if (typeof value !== "string" && typeof value !== "number") return null
  const text = String(value)
  if (!/^-?\d+$/.test(text)) return null
  const coordinate = Number(text)
  return Number.isSafeInteger(coordinate) && Math.abs(coordinate) <= MAX_COORDINATE ? coordinate : null
}

function readId(value) {
  return typeof value === "string" && /^[a-z0-9_]+$/.test(value) ? value : ""
}

function getPublicOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) {
    const configured = new URL(process.env.PUBLIC_ORIGIN)
    if (["http:", "https:"].includes(configured.protocol)) return configured.origin
  }
  const host = String(req.headers.host || "")
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return "http://127.0.0.1:5173"
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)
  return `${local ? "http" : "https"}://${host}`
}

function getAssetOrigin(req) {
  if (process.env.SHARE_ASSET_ORIGIN) return process.env.SHARE_ASSET_ORIGIN.replace(/\/$/, "")
  // Deployment aliases may be access-protected and return HTML instead of public assets.
  const publicOrigin = req ? getPublicOrigin(req) : "http://127.0.0.1:5173"
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(publicOrigin)
    ? "http://127.0.0.1:5173"
    : publicOrigin
}

async function fetchAsset(path, assetOrigin) {
  const response = await fetch(new URL(path, assetOrigin || getAssetOrigin()), {
    signal: AbortSignal.timeout(7000)
  })
  if (!response.ok) throw new Error(`Asset ${path}: ${response.status}`)
  return response
}

async function fetchJson(path, assetOrigin) {
  const response = await fetchAsset(path, assetOrigin)
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error(`Asset ${path} did not return JSON`)
  }
  return response.json()
}

function resolveDimensionPath(source, worldId, dimensionId) {
  if (typeof source !== "string") return ""
  const prefix = `/maps/${worldId}/tiles/`
  if (!source.startsWith(prefix)) return ""
  const rest = source.slice(prefix.length).replace(/^(overworld|nether|end|pale)\//, "")
  return `${prefix}${dimensionId}/${rest}`
}

export function getPreviewBucket(x, z) {
  return {
    x: Math.floor(x / BUCKET_SIZE) * BUCKET_SIZE + BUCKET_SIZE / 2,
    z: Math.floor(z / BUCKET_SIZE) * BUCKET_SIZE + BUCKET_SIZE / 2
  }
}

export function parseShareRequest(params) {
  const worldId = readId(params.world)
  const dimensionId = readId(params.dimension)
  const x = readCoordinate(params.x)
  const z = readCoordinate(params.z)
  return worldId && dimensionId && x !== null && z !== null
    ? { worldId, dimensionId, x, z }
    : null
}

export async function loadShareContext(params, req) {
  const location = parseShareRequest(params)
  if (!location) return null

  const assetOrigin = getAssetOrigin(req)
  const catalog = await fetchJson("/maps/catalog.json", assetOrigin)
  const world = catalog.worlds?.find((item) => item.id === location.worldId && item.status === "active")
  const dimension = world?.dimensions?.find((item) => item.id === location.dimensionId && item.enabled)
  if (!world || !dimension) return null

  const manifestPath = dimension.manifestPath || world.manifestPath
  if (typeof manifestPath !== "string" || !manifestPath.startsWith(`/maps/${world.id}/`)) return null
  const manifest = await fetchJson(manifestPath, assetOrigin)
  if (!manifest?.bounds || !Array.isArray(manifest.tiles) || !Number.isFinite(Number(manifest.tileSize))) return null

  return { ...location, world, dimension, manifest, assetOrigin }
}

function shareQuery(context) {
  const params = new URLSearchParams({
    world: context.worldId,
    dimension: context.dimensionId,
    x: String(context.x),
    z: String(context.z)
  })
  return params
}

export function renderShareHtml(req, context) {
  const origin = getPublicOrigin(req)
  const sharedUrl = new URL(`/s/${context.worldId}/${context.dimensionId}/${context.x}/${context.z}`, origin)
  if (req.query?.v) sharedUrl.searchParams.set("v", String(req.query.v).slice(0, 64))

  const mapUrl = new URL(`/${context.worldId}`, origin)
  mapUrl.searchParams.set("dimension", context.dimensionId)
  mapUrl.searchParams.set("x", String(context.x))
  mapUrl.searchParams.set("z", String(context.z))

  const bucket = getPreviewBucket(context.x, context.z)
  const imageQuery = shareQuery({ ...context, x: bucket.x, z: bucket.z })
  imageQuery.set("v", String(context.manifest.generatedAt || context.manifest.version || "1"))
  const imageUrl = new URL(`/api/share-image?${imageQuery}`, origin).toString()
  const place = `X ${context.x} Z ${context.z}`
  const worldName = context.world.shortLabel || context.world.label || context.worldId
  const dimensionName = context.dimensionId === "overworld" ? "" : ` / ${context.dimension.label || context.dimensionId}`
  const title = `PepeMaps — ${place} · ${worldName}${dimensionName}`
  const authorName = process.env.SHARE_AUTHOR_NAME || "YarilaFox"
  const authorUrl = process.env.SHARE_AUTHOR_URL || "https://github.com/YarilaFox"
  const description = `Данный проект не является официальной частью сети серверов PepeLand. Создано ${authorName}.`

  const embed = {
    component: {
      type: 17,
      accent_color: 0x79aa71,
      components: [
        { type: 10, content: `### [${title}](${sharedUrl})\n-# Данный проект не является официальной частью сети серверов [PepeLand](https://pepeland.net).` },
        { type: 12, items: [{ media: { url: imageUrl }, description: `Карта ${worldName}, ${place}` }] },
        { type: 10, content: `-# Создано [${authorName}](${authorUrl})` }
      ]
    }
  }
  const inlineJson = JSON.stringify(embed).replaceAll("<", "\\u003c")

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="PepeMaps">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(sharedUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="${IMAGE_WIDTH}">
  <meta property="og:image:height" content="${IMAGE_HEIGHT}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
  <script id="discord:component-embed" type="application/vnd.discord.component-embed+json">${inlineJson}</script>
  <script>window.location.replace(${JSON.stringify(mapUrl.toString()).replaceAll("<", "\\u003c")})</script>
</head>
<body style="background:#101813;color:#f5f5ef;font:16px sans-serif">
  <p>Открываем <a style="color:#9cd18f" href="${escapeHtml(mapUrl)}">${escapeHtml(title)}</a>...</p>
</body>
</html>`
}

function getCrop(context) {
  const { x, z } = getPreviewBucket(context.x, context.z)
  const bounds = context.manifest.bounds
  const minX = Number(bounds.minX)
  const minZ = Number(bounds.minZ)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  const clampStart = (start, min, size, cropSize) =>
    size >= cropSize ? Math.max(min, Math.min(start, min + size - cropSize)) : min - Math.floor((cropSize - size) / 2)

  return {
    left: clampStart(x - CROP_WIDTH / 2, minX, width, CROP_WIDTH),
    top: clampStart(z - Math.floor(CROP_HEIGHT / 2), minZ, height, CROP_HEIGHT),
    width: CROP_WIDTH,
    height: CROP_HEIGHT
  }
}

async function loadTileBuffer(tile, context) {
  const sources = [tile.srcWebp, tile.srcPng, tile.src]
    .map((source) => resolveDimensionPath(source, context.worldId, context.dimensionId))
    .filter((source, index, all) => source && all.indexOf(source) === index)

  for (const source of sources) {
    try {
      const response = await fetchAsset(source, context.assetOrigin)
      if (!response.headers.get("content-type")?.startsWith("image/")) continue
      return Buffer.from(await response.arrayBuffer())
    } catch {
      // A missing WebP tile can still use its PNG source.
    }
  }
  return null
}

export async function renderShareImage(context) {
  const crop = getCrop(context)
  const tileSize = Number(context.manifest.tileSize)
  const candidates = context.manifest.tiles.filter((tile) => {
    const x = Number(tile.x)
    const z = Number(tile.z)
    return Number.isFinite(x) && Number.isFinite(z) &&
      x < crop.left + crop.width && x + tileSize > crop.left &&
      z < crop.top + crop.height && z + tileSize > crop.top
  })

  const layers = await Promise.all(candidates.map(async (tile) => {
    const data = await loadTileBuffer(tile, context)
    if (!data) return null

    const x = Number(tile.x)
    const z = Number(tile.z)
    const left = Math.max(crop.left, x)
    const top = Math.max(crop.top, z)
    const right = Math.min(crop.left + crop.width, x + tileSize)
    const bottom = Math.min(crop.top + crop.height, z + tileSize)
    if (right <= left || bottom <= top) return null

    try {
      return {
        input: await sharp(data).extract({
          left: left - x,
          top: top - z,
          width: right - left,
          height: bottom - top
        }).png().toBuffer(),
        left: left - crop.left,
        top: top - crop.top
      }
    } catch {
      return null
    }
  }))

  if (!layers.some(Boolean)) {
    const placeholder = Buffer.from(`<svg width="${CROP_WIDTH}" height="${CROP_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#101813"/><text x="50%" y="49%" text-anchor="middle" fill="#f5f5ef" font-family="sans-serif" font-size="38">PepeMaps</text><text x="50%" y="57%" text-anchor="middle" fill="#a6b5a6" font-family="sans-serif" font-size="20">${context.worldId} / ${context.dimensionId}</text></svg>`)
    return sharp(placeholder).resize(IMAGE_WIDTH, IMAGE_HEIGHT).jpeg({ quality: 83 }).toBuffer()
  }

  const composed = await sharp({
    create: { width: crop.width, height: crop.height, channels: 3, background: "#101813" }
  })
    .composite(layers.filter(Boolean))
    .png()
    .toBuffer()

  return sharp(composed)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { kernel: sharp.kernel.nearest })
    .jpeg({ quality: 83, mozjpeg: true })
    .toBuffer()
}
