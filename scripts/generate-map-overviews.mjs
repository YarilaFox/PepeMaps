import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"

const PUBLIC_DIR = path.resolve("public")
const THUMB_PX = 256
const PREVIEW_TILE_PX = 512
const PREVIEW_GROUP_SIZE = 2

function publicFile(url) {
  const relative = String(url || "").replace(/^\/+/, "")
  const absolute = path.resolve(PUBLIC_DIR, relative)
  if (!absolute.startsWith(`${PUBLIC_DIR}${path.sep}`)) throw new Error(`Invalid map path: ${url}`)
  return absolute
}

async function replaceGeneratedFile(temporaryFile, outputFile) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(temporaryFile, outputFile)
      return
    } catch (error) {
      if (!['EPERM', 'EEXIST'].includes(error?.code)) throw error
      try {
        await fs.copyFile(temporaryFile, outputFile)
        return
      } catch (copyError) {
        if (attempt === 4 || !['EPERM', 'UNKNOWN', 'EBUSY'].includes(copyError?.code)) throw copyError
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
}

async function existingSource(tile) {
  for (const url of [tile.srcWebp, tile.srcPng, tile.src]) {
    if (!url) continue
    const file = publicFile(url)
    try {
      await fs.access(file)
      return file
    } catch {
      // Try the next format declared by the manifest.
    }
  }
  throw new Error(`No source image for tile ${tile.id}`)
}

async function generateOverview(manifestUrl) {
  const manifestFile = publicFile(manifestUrl)
  const overviewFile = path.join(path.dirname(manifestFile), "overview.webp")
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"))
  const tileSize = Number(manifest.tileSize)
  const width = Math.ceil(Number(manifest.bounds?.width) / tileSize) * THUMB_PX
  const height = Math.ceil(Number(manifest.bounds?.height) / tileSize) * THUMB_PX
  if (!manifest.tiles?.length || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid map manifest: ${manifestUrl}`)
  }

  const sources = await Promise.all(manifest.tiles.map(existingSource))
  const overviewTime = await fs.stat(overviewFile).then((stat) => stat.mtimeMs).catch(() => 0)
  const inputs = [manifestFile, ...sources]
  const latestInputTime = Math.max(...await Promise.all(inputs.map(async (file) => (await fs.stat(file)).mtimeMs)))
  const existingSize = await sharp(overviewFile).metadata().catch(() => null)
  if (overviewTime >= latestInputTime && existingSize?.width === width && existingSize?.height === height) return false

  const overlays = []
  for (let index = 0; index < manifest.tiles.length; index += 1) {
    const tile = manifest.tiles[index]
    const left = Math.round((Number(tile.x) - Number(manifest.bounds.minX)) / tileSize) * THUMB_PX
    const top = Math.round((Number(tile.z) - Number(manifest.bounds.minZ)) / tileSize) * THUMB_PX
    const input = await sharp(sources[index]).resize(THUMB_PX, THUMB_PX, { fit: "fill" }).webp({ quality: 82 }).toBuffer()
    overlays.push({ input, left, top })
  }

  const temporaryFile = `${overviewFile}.tmp.webp`
  try {
    await sharp({ create: { width, height, channels: 4, background: "#030403" } })
      .composite(overlays)
      .webp({ quality: 82, effort: 4 })
      .toFile(temporaryFile)
    await replaceGeneratedFile(temporaryFile, overviewFile)
  } finally {
    await fs.rm(temporaryFile, { force: true })
  }
  console.log(`${manifestUrl}: ${width}x${height}, ${(await fs.stat(overviewFile)).size} bytes`)
  return true
}

async function generatePreviews(manifestUrl) {
  const manifestFile = publicFile(manifestUrl)
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"))
  const directory = path.dirname(manifestFile)
  const tileSize = Number(manifest.tileSize)
  const columns = Math.ceil(Number(manifest.bounds.width) / tileSize)
  const rows = Math.ceil(Number(manifest.bounds.height) / tileSize)
  const groups = new Map()

  for (const tile of manifest.tiles) {
    const column = Math.round((Number(tile.x) - Number(manifest.bounds.minX)) / tileSize)
    const row = Math.round((Number(tile.z) - Number(manifest.bounds.minZ)) / tileSize)
    const groupColumn = Math.floor(column / PREVIEW_GROUP_SIZE)
    const groupRow = Math.floor(row / PREVIEW_GROUP_SIZE)
    const key = `${groupColumn}_${groupRow}`
    if (!groups.has(key)) groups.set(key, { key, groupColumn, groupRow, tiles: [] })
    groups.get(key).tiles.push({ tile, column, row })
  }

  const previews = []
  for (const group of groups.values()) {
    const groupColumns = Math.min(PREVIEW_GROUP_SIZE, columns - group.groupColumn * PREVIEW_GROUP_SIZE)
    const groupRows = Math.min(PREVIEW_GROUP_SIZE, rows - group.groupRow * PREVIEW_GROUP_SIZE)
    const outputFile = path.join(directory, `preview-${group.key}.webp`)
    const sources = await Promise.all(group.tiles.map(({ tile }) => existingSource(tile)))
    const latestInputTime = Math.max((await fs.stat(manifestFile)).mtimeMs,
      ...await Promise.all(sources.map(async (file) => (await fs.stat(file)).mtimeMs)))
    const outputTime = await fs.stat(outputFile).then((stat) => stat.mtimeMs).catch(() => 0)

    if (outputTime < latestInputTime) {
      const overlays = []
      for (let index = 0; index < group.tiles.length; index += 1) {
        const { column, row } = group.tiles[index]
        overlays.push({
          input: await sharp(sources[index]).resize(PREVIEW_TILE_PX, PREVIEW_TILE_PX, { fit: "fill" }).png().toBuffer(),
          left: (column - group.groupColumn * PREVIEW_GROUP_SIZE) * PREVIEW_TILE_PX,
          top: (row - group.groupRow * PREVIEW_GROUP_SIZE) * PREVIEW_TILE_PX
        })
      }

      const temporaryFile = `${outputFile}.tmp.webp`
      try {
        await sharp({ create: {
          width: groupColumns * PREVIEW_TILE_PX,
          height: groupRows * PREVIEW_TILE_PX,
          channels: 4,
          background: "#030403"
        } }).composite(overlays).webp({ quality: 88, effort: 4 }).toFile(temporaryFile)
        await replaceGeneratedFile(temporaryFile, outputFile)
      } finally {
        await fs.rm(temporaryFile, { force: true })
      }
    }

    previews.push({
      id: group.key,
      x: Number(manifest.bounds.minX) + group.groupColumn * PREVIEW_GROUP_SIZE * tileSize,
      z: Number(manifest.bounds.minZ) + group.groupRow * PREVIEW_GROUP_SIZE * tileSize,
      width: groupColumns * tileSize,
      height: groupRows * tileSize,
      src: `${manifestUrl.replace(/manifest\.json$/, "")}preview-${group.key}.webp`
    })
  }

  const metadataFile = path.join(directory, "previews.json")
  const metadata = `${JSON.stringify({ version: 1, tiles: previews }, null, 2)}\n`
  if (await fs.readFile(metadataFile, "utf8").catch(() => "") !== metadata) await fs.writeFile(metadataFile, metadata)
  console.log(`${manifestUrl}: ${previews.length} preview groups`)
}

const catalog = JSON.parse(await fs.readFile(publicFile("/maps/catalog.json"), "utf8"))
for (const world of catalog.worlds || []) {
  for (const dimension of world.dimensions || []) {
    if (!dimension.enabled) continue
    const manifestUrl = dimension.manifestPath || world.manifestPath
    try {
      await generateOverview(manifestUrl)
    } catch (error) {
      if (!['EPERM', 'UNKNOWN', 'EBUSY'].includes(error?.code)) throw error
      console.warn(`${manifestUrl}: overview locked by another process; keeping existing image`)
    }
    await generatePreviews(manifestUrl)
  }
}
