import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_TILE_SIZE = 1024
const DEFAULT_CENTER_TILES = []

function parseArgs(argv) {
  const options = {
    tilesDir: "",
    outFile: "",
    tileSize: DEFAULT_TILE_SIZE,
    baseImage: "",
    centerTiles: DEFAULT_CENTER_TILES
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      continue
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (typeof value !== "string" || value.startsWith("--")) {
      continue
    }

    if (key === "tiles-dir") {
      options.tilesDir = value
      index += 1
      continue
    }

    if (key === "out") {
      options.outFile = value
      index += 1
      continue
    }

    if (key === "tile-size") {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        options.tileSize = parsed
      }
      index += 1
      continue
    }

    if (key === "base-image") {
      options.baseImage = value
      index += 1
      continue
    }

    if (key === "center-tiles") {
      const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      options.centerTiles = items.length > 0 ? items : DEFAULT_CENTER_TILES
      index += 1
    }
  }

  if (!options.tilesDir || !options.outFile) {
    throw new Error("Provide --tiles-dir and --out explicitly to avoid overwriting an existing world")
  }
  return options
}

function roundNumeric(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Number(value.toFixed(digits))
}

function parseTileFileName(fileName) {
  const match = fileName.match(/^(\d+)_(\d+)_x(-?\d+)_z(-?\d+)\.(png|webp)$/i)
  if (!match) {
    return null
  }

  const col = Number.parseInt(match[1], 10)
  const row = Number.parseInt(match[2], 10)
  const x = Number.parseInt(match[3], 10)
  const z = Number.parseInt(match[4], 10)
  const format = String(match[5]).toLowerCase()

  if (!Number.isFinite(col) || !Number.isFinite(row) || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null
  }

  return {
    id: `${col}_${row}`,
    col,
    row,
    x,
    z,
    format
  }
}

export async function generateManifest(options) {
  const cwd = process.cwd()
  const tilesDirAbs = path.resolve(cwd, options.tilesDir)
  const outFileAbs = path.resolve(cwd, options.outFile)
  const tileSize = options.tileSize
  const baseImage = options.baseImage || ""

  const entries = await fs.readdir(tilesDirAbs, { withFileTypes: true })
  const tileVariants = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parsed = parseTileFileName(entry.name)
      if (!parsed) {
        return null
      }

      const tilePathAbs = path.join(tilesDirAbs, entry.name)
      const tilePathRel = path.relative(cwd, tilePathAbs).replaceAll("\\", "/").replace(/^public\//, "")
      return {
        id: parsed.id,
        col: parsed.col,
        row: parsed.row,
        x: parsed.x,
        z: parsed.z,
        format: parsed.format,
        src: `/${tilePathRel}`
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.col - b.col) || (a.row - b.row) || a.src.localeCompare(b.src))

  const groupedTiles = new Map()
  tileVariants.forEach((tile) => {
    const existing = groupedTiles.get(tile.id) || {
      id: tile.id,
      col: tile.col,
      row: tile.row,
      x: tile.x,
      z: tile.z,
      src: "",
      srcWebp: "",
      srcPng: ""
    }

    if (tile.format === "webp") {
      existing.srcWebp = tile.src
    }
    if (tile.format === "png") {
      existing.srcPng = tile.src
    }

    existing.src = existing.srcWebp || existing.srcPng || tile.src
    groupedTiles.set(tile.id, existing)
  })

  const tiles = Array.from(groupedTiles.values()).sort((a, b) => (a.col - b.col) || (a.row - b.row) || a.src.localeCompare(b.src))

  if (tiles.length === 0) {
    throw new Error(`No tile files found in: ${tilesDirAbs}`)
  }

  const minX = Math.min(...tiles.map((tile) => tile.x))
  const minZ = Math.min(...tiles.map((tile) => tile.z))
  const maxX = Math.max(...tiles.map((tile) => tile.x + tileSize))
  const maxZ = Math.max(...tiles.map((tile) => tile.z + tileSize))
  const width = maxX - minX
  const height = maxZ - minZ

  const byId = new Map(tiles.map((tile) => [tile.id, tile]))
  const centerTiles = options.centerTiles
    .map((id) => byId.get(id))
    .filter(Boolean)

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tileSize,
    baseImage,
    bounds: {
      minX,
      minZ,
      width,
      height
    },
    focus: null,
    tiles: tiles.map((tile) => ({
      id: tile.id,
      x: tile.x,
      z: tile.z,
      src: tile.src,
      srcWebp: tile.srcWebp || "",
      srcPng: tile.srcPng || ""
    }))
  }

  if (centerTiles.length > 0) {
    const centerWorldX = centerTiles.reduce((sum, tile) => sum + (tile.x + tileSize / 2), 0) / centerTiles.length
    const centerWorldZ = centerTiles.reduce((sum, tile) => sum + (tile.z + tileSize / 2), 0) / centerTiles.length
    manifest.focus = {
      x: roundNumeric((centerWorldX - minX) / width, 6),
      y: roundNumeric((centerWorldZ - minZ) / height, 6),
      tileIds: centerTiles.map((tile) => tile.id)
    }
  }

  await fs.mkdir(path.dirname(outFileAbs), { recursive: true })
  await fs.writeFile(outFileAbs, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

  return {
    outFileAbs,
    tileCount: tiles.length,
    bounds: manifest.bounds,
    focus: manifest.focus
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await generateManifest(options)
    console.log(`Map manifest generated: ${result.outFileAbs}`)
    console.log(`Tiles: ${result.tileCount}`)
    console.log(`Bounds: minX=${result.bounds.minX}, minZ=${result.bounds.minZ}, width=${result.bounds.width}, height=${result.bounds.height}`)
    if (result.focus) {
      console.log(`Focus: x=${result.focus.x}, y=${result.focus.y} (tiles: ${result.focus.tileIds.join(", ")})`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
