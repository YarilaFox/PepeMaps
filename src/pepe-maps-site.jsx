import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

const SEARCH_RESULTS_LIMIT = 8
const TILE_VIEW_PADDING_PX = 256
// Zoom hysteresis avoids repeatedly mounting full-resolution images at one threshold.
const DETAIL_ZOOM_ENTER = 2.6
const DETAIL_ZOOM_EXIT = 2.4
const PREVIEW_ZOOM_ENTER = 1.65
const PREVIEW_ZOOM_EXIT = 1.45
const MAX_TILE_REQUESTS = 4
const MAX_PREVIEW_REQUESTS = 2
const MARKER_VIEW_PADDING_PX = 160
const MAP_VIEW_COOKIE_NAME = "pepe_maps_view"
const MAP_VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30
const DEFAULT_CATALOG = {
  season: "10",
  defaultWorldId: "build_2",
  defaultDimensionId: "overworld",
  discord: "@yarila",
  worlds: []
}

function getWorldIdFromPathname(pathname, worlds) {
  const validWorldIds = Array.isArray(worlds) ? worlds.map((world) => readString(world?.id)).filter(Boolean) : []
  const normalizedPath = readString(pathname).replace(/^\/+|\/+$/g, "")
  if (!normalizedPath) {
    return ""
  }

  const [candidate] = normalizedPath.split("/")
  return validWorldIds.includes(candidate) ? candidate : ""
}

function clampNumeric(value, min, max, fallback = min) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }

  if (numeric < min) {
    return min
  }

  if (numeric > max) {
    return max
  }

  return numeric
}

function readString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function getOverviewUrl(manifestPath, version) {
  if (!manifestPath?.endsWith("/manifest.json")) return ""
  return `${manifestPath.replace(/manifest\.json$/, "overview.webp")}?v=${encodeURIComponent(version || "1")}`
}

function escapeHtml(value) {
  return readString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
}

async function fetchJsonFile(url) {
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  return response.json()
}

function getFirstEnabledDimension(world, fallback = "overworld") {
  if (!world || !Array.isArray(world.dimensions)) {
    return fallback
  }

  return world.dimensions.find((dimension) => dimension?.enabled)?.id || fallback
}

function buildTileMeta(manifest) {
  const bounds = manifest?.bounds && typeof manifest.bounds === "object" ? manifest.bounds : null
  const tiles = Array.isArray(manifest?.tiles) ? manifest.tiles : []
  const minX = Number(bounds?.minX)
  const minZ = Number(bounds?.minZ)
  const width = Number(bounds?.width)
  const height = Number(bounds?.height)
  const tileSize = Number(manifest?.tileSize)

  if (!tiles.length || !Number.isFinite(minX) || !Number.isFinite(minZ) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return {
      enabled: false,
      width: 0,
      height: 0,
      minX: 0,
      minZ: 0,
      aspectRatio: 1,
      tiles: [],
      signature: "disabled"
    }
  }

  const safeTileSize = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 1024
  const preparedTiles = tiles
    .map((tile, index) => {
      const x = Number(tile?.x)
      const z = Number(tile?.z)
      const src = readString(tile?.src)
      const srcWebp = readString(tile?.srcWebp)
      const srcPng = readString(tile?.srcPng)
      const sources = [srcWebp, srcPng, src].filter(Boolean)
      if (!Number.isFinite(x) || !Number.isFinite(z) || sources.length === 0) {
        return null
      }

      return {
        key: readString(tile?.id) || `tile-${index + 1}`,
        src: sources[0],
        sources,
        left: x - minX,
        top: z - minZ,
        right: x - minX + safeTileSize,
        bottom: z - minZ + safeTileSize
      }
    })
    .filter(Boolean)

  return {
    enabled: preparedTiles.length > 0,
    width,
    height,
    minX,
    minZ,
    aspectRatio: width > 0 && height > 0 ? width / height : 1,
    tiles: preparedTiles,
    signature: preparedTiles.map((tile) => `${tile.key}:${tile.sources.join(",")}`).join("|")
  }
}

function buildPreviewTiles(manifest, tileMeta) {
  if (!tileMeta.enabled) return []
  return (Array.isArray(manifest?.previewTiles) ? manifest.previewTiles : [])
    .map((tile) => {
      const x = Number(tile?.x)
      const z = Number(tile?.z)
      const width = Number(tile?.width)
      const height = Number(tile?.height)
      const src = readString(tile?.src)
      if (![x, z, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || !src) return null
      return {
        key: readString(tile?.id) || `${x}_${z}`,
        src,
        sources: [src],
        left: x - tileMeta.minX,
        top: z - tileMeta.minZ,
        right: x - tileMeta.minX + width,
        bottom: z - tileMeta.minZ + height
      }
    })
    .filter(Boolean)
}

function createWorldMeta(tileMeta, manifest) {
  if (!tileMeta.enabled) {
    return null
  }

  const focusX = clampNumeric(manifest?.focus?.x, 0, 1, 0.5)
  const focusY = clampNumeric(manifest?.focus?.y, 0, 1, 0.5)

  return {
    width: tileMeta.width,
    height: tileMeta.height,
    minX: tileMeta.minX,
    minZ: tileMeta.minZ,
    focusX,
    focusY,
    bounds: L.latLngBounds([[0, 0], [tileMeta.height, tileMeta.width]]),
    maxBounds: L.latLngBounds([
      [-tileMeta.height * 0.18, -tileMeta.width * 0.18],
      [tileMeta.height * 1.18, tileMeta.width * 1.18]
    ])
  }
}

function resolveDimensionAssetPath(src, worldId, dimensionId) {
  const source = readString(src)
  const safeWorldId = readString(worldId)
  const safeDimensionId = readString(dimensionId) || "overworld"

  if (!source || !safeWorldId) {
    return source
  }

  const worldPrefix = `/maps/${safeWorldId}/tiles/`
  if (!source.includes(worldPrefix)) {
    return source
  }

  const remainder = source.slice(source.indexOf(worldPrefix) + worldPrefix.length)
  const normalizedRemainder = remainder.replace(/^(overworld|nether|end|pale)\//, "")
  return `${worldPrefix}${safeDimensionId}/${normalizedRemainder}`
}

function resolveManifestForDimension(manifest, worldId, dimensionId) {
  if (!manifest || typeof manifest !== "object") {
    return manifest
  }

  return {
    ...manifest,
    baseImage: resolveDimensionAssetPath(manifest.baseImage, worldId, dimensionId),
    tiles: Array.isArray(manifest.tiles)
      ? manifest.tiles.map((tile) => ({
          ...tile,
          src: resolveDimensionAssetPath(tile?.src, worldId, dimensionId),
          srcWebp: resolveDimensionAssetPath(tile?.srcWebp, worldId, dimensionId),
          srcPng: resolveDimensionAssetPath(tile?.srcPng, worldId, dimensionId)
        }))
      : []
  }
}

function toLatLng(localX, localZ, worldMeta) {
  // Tile Z points downward; Leaflet latitude points upward.
  return L.latLng(worldMeta.height - localZ, localX)
}

function toLeafletBounds(tile, worldMeta) {
  return L.latLngBounds(
    [worldMeta.height - tile.bottom, tile.left],
    [worldMeta.height - tile.top, tile.right]
  )
}

function reconcileImageLayers({ map, worldMeta, tiles, visibleRect, layerGroup, entriesRef, queueRef, pane, className, maxRequests }) {
  const entries = entriesRef.current
  const queue = queueRef.current
  const visibleTiles = visibleRect ? tiles.filter((tile) => (
    tile.right >= visibleRect.left && tile.left <= visibleRect.right &&
    tile.bottom >= visibleRect.top && tile.top <= visibleRect.bottom
  )) : []
  const nextKeys = new Set(visibleTiles.map((tile) => tile.key))

  entries.forEach((entry, key) => {
    if (nextKeys.has(key)) return
    if (entry.loading) queue.active = Math.max(0, queue.active - 1)
    layerGroup.removeLayer(entry.layer)
    entries.delete(key)
  })

  const center = map.getCenter()
  const centerX = center.lng
  const centerZ = worldMeta.height - center.lat
  // Load the nearest visible images first and bound concurrent network requests.
  queue.pending = visibleTiles
    .filter((tile) => !entries.has(tile.key))
    .sort((a, b) => (
      Math.hypot((a.left + a.right) / 2 - centerX, (a.top + a.bottom) / 2 - centerZ) -
      Math.hypot((b.left + b.right) / 2 - centerX, (b.top + b.bottom) / 2 - centerZ)
    ))

  queue.pump = () => {
    while (queue.active < maxRequests && queue.pending.length) {
      const tile = queue.pending.shift()
      if (entries.has(tile.key)) continue
      const layer = L.imageOverlay(tile.sources[0] || tile.src, toLeafletBounds(tile, worldMeta), {
        pane,
        interactive: false,
        className
      })
      const entry = { layer, loading: true, sourceIndex: 0 }
      entries.set(tile.key, entry)
      queue.active += 1
      const finish = () => {
        if (entries.get(tile.key) !== entry || !entry.loading) return false
        entry.loading = false
        queue.active = Math.max(0, queue.active - 1)
        return true
      }
      layer.on("load", () => {
        if (!finish()) return
        const element = layer.getElement()
        if (element) window.requestAnimationFrame(() => element.classList.add("is-loaded"))
        queue.pump()
      })
      layer.on("error", () => {
        entry.sourceIndex += 1
        const fallbackSrc = tile.sources[entry.sourceIndex]
        if (fallbackSrc) layer.setUrl(fallbackSrc)
        else if (finish()) {
          layerGroup.removeLayer(layer)
          queue.pump()
        }
      })
      layer.addTo(layerGroup)
    }
  }
  queue.pump()
}

function markerToLatLng(marker, worldMeta) {
  const localX = marker.x - worldMeta.minX
  const localZ = marker.z - worldMeta.minZ
  return toLatLng(localX, localZ, worldMeta)
}

function getMarkerWeight(marker) {
  return clampNumeric(marker?.weight, 1, 10, 8)
}

function getMarkerVisibilityThreshold(currentZoom, fitZoom) {
  const delta = currentZoom - fitZoom

  if (delta <= -0.9) return 10
  if (delta <= -0.35) return 9
  if (delta <= 0.1) return 8
  if (delta <= 0.55) return 7
  if (delta <= 1) return 6
  if (delta <= 1.45) return 5
  if (delta <= 1.9) return 4
  if (delta <= 2.35) return 3
  if (delta <= 2.8) return 2
  return 1
}

function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "absolute"
  textarea.style.left = "-9999px"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  document.body.removeChild(textarea)
  if (!copied) {
    return Promise.reject(new Error("Clipboard unavailable"))
  }
  return Promise.resolve()
}

function getMarkerGlyph(type) {
  switch (type) {
    case "portal":
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5A2.5 2.5 0 0 1 5.5 1h5A2.5 2.5 0 0 1 13 3.5v9a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 3 12.5zm2.5-1a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1zm.5 2h4v7H6z" fill="currentColor"/></svg>'
    case "event":
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 9.93 5.1l4.3.63-3.11 3.03.73 4.28L8 11.02l-3.85 2.02.73-4.28L1.77 5.73l4.3-.63z" fill="currentColor"/></svg>'
    case "farm":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10.975V8a2 2 0 0 0-2-2h-6V4.688c.305-.274.5-.668.5-1.11a1.5 1.5 0 0 0-3 0c0 .442.195.836.5 1.11V6H5a2 2 0 0 0-2 2v2.998l-.072.005A1 1 0 0 0 2 12v2a1 1 0 0 0 1 1v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a1 1 0 0 0 1-1v-1.938a1 1 0 0 0-.072-.455c-.202-.488-.635-.605-.928-.632M7 12c0-1.104.672-2 1.5-2s1.5.896 1.5 2-.672 2-1.5 2S7 13.104 7 12m8.998 6c-1.001-.003-7.997 0-7.998 0v-2s7.001-.002 8.002 0zm-.498-4c-.828 0-1.5-.896-1.5-2s.672-2 1.5-2 1.5.896 1.5 2-.672 2-1.5 2" fill="currentColor"/></svg>'
    default:
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 1 4.5 4.5c0 2.92-2.35 5.56-3.82 6.98a.96.96 0 0 1-1.36 0C5.85 11.56 3.5 8.92 3.5 6A4.5 4.5 0 0 1 8 1.5m0 2A2.5 2.5 0 1 0 8 8.5 2.5 2.5 0 0 0 8 3.5" fill="currentColor"/></svg>'
  }
}

function isHexColor(value) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(readString(value))
}

function getMarkerAccent(marker) {
  const customColor = readString(marker?.color)
  if (isHexColor(customColor)) {
    return customColor
  }

  switch (readString(marker?.type)) {
    case "portal":
      return "#c084fc"
    case "event":
      return "#ffcb66"
    case "farm":
      return "#8ee17b"
    default:
      return "#dceada"
  }
}

function renderCustomMarkerIcon(iconValue) {
  const icon = readString(iconValue)
  if (!icon) {
    return ""
  }

  if (icon.startsWith("<svg")) {
    return icon
  }

  if (icon.startsWith("<path")) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>`
  }

  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${escapeHtml(icon)}" fill="currentColor"/></svg>`
}

function createMarkerIcon(marker) {
  const name = escapeHtml(marker.name)
  const customIcon = renderCustomMarkerIcon(marker.icon)
  const glyph = customIcon || getMarkerGlyph(marker.type)
  const accent = escapeHtml(getMarkerAccent(marker))
  return L.divIcon({
    className: "pepe-map-marker-host",
    html: `
      <div class="pepe-map-marker" data-marker-id="${escapeHtml(marker.id || "")}" data-type="${escapeHtml(marker.type || "project")}" style="--marker-accent:${accent}">
        <div class="pepe-map-marker-main">
          <span class="pepe-map-marker-icon">${glyph}</span>
          <span class="pepe-map-marker-name">${name}</span>
        </div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  })
}

function createClusterIcon(cluster) {
  const count = Math.max(2, Number(cluster?.clusterCount) || 2)
  const title = count === 1 ? "1 точка" : `${count} точек`

  return L.divIcon({
    className: "pepe-map-marker-host",
    html: `
      <div class="pepe-map-marker pepe-map-marker-cluster is-visible" data-type="cluster" data-marker-id="${escapeHtml(cluster.id || "")}" style="--marker-accent:#8dbdff">
        <div class="pepe-map-marker-main">
          <span class="pepe-map-marker-count">${count}</span>
          <span class="pepe-map-marker-name">${escapeHtml(title)}</span>
        </div>
        <div class="pepe-map-marker-copy">Приблизь карту, чтобы раскрыть точки</div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  })
}

function clusterMarkersForViewport(markers, worldMeta, map, fitZoom) {
  if (!map || !worldMeta || !Array.isArray(markers) || markers.length === 0) {
    return []
  }

  const zoom = map.getZoom()
  const delta = zoom - fitZoom
  const gridSize = delta <= 0 ? 84 : delta <= 0.8 ? 68 : delta <= 1.6 ? 56 : 44
  const buckets = new Map()

  markers.forEach((marker) => {
    const point = map.latLngToContainerPoint(marker.latlng || markerToLatLng(marker, worldMeta))
    const bucketKey = `${Math.floor(point.x / gridSize)}:${Math.floor(point.y / gridSize)}`
    const bucket = buckets.get(bucketKey) || []
    bucket.push({ marker, point })
    buckets.set(bucketKey, bucket)
  })

  return Array.from(buckets.values()).map((bucket, index) => {
    if (bucket.length === 1) {
      return {
        kind: "marker",
        id: bucket[0].marker.id,
        marker: bucket[0].marker
      }
    }

    const avgX = Math.round(bucket.reduce((sum, item) => sum + item.marker.x, 0) / bucket.length)
    const avgZ = Math.round(bucket.reduce((sum, item) => sum + item.marker.z, 0) / bucket.length)
    const avgPointX = bucket.reduce((sum, item) => sum + item.point.x, 0) / bucket.length
    const avgPointY = bucket.reduce((sum, item) => sum + item.point.y, 0) / bucket.length
    const latlng = map.containerPointToLatLng(L.point(avgPointX, avgPointY))

    return {
      kind: "cluster",
      id: `cluster:${index}:${bucket.map((item) => item.marker.id).sort().join("|")}`,
      clusterCount: bucket.length,
      markers: bucket.map((item) => item.marker),
      x: avgX,
      z: avgZ,
      latlng
    }
  })
}

function clonePreclickEvent(sourceEvent) {
  const clone = {
    type: "preclick",
    originalEvent: sourceEvent.originalEvent || sourceEvent
  }

  const fields = [
    "target",
    "srcElement",
    "currentTarget",
    "relatedTarget",
    "clientX",
    "clientY",
    "screenX",
    "screenY",
    "pageX",
    "pageY",
    "button",
    "buttons",
    "ctrlKey",
    "shiftKey",
    "altKey",
    "metaKey",
    "detail",
    "containerPoint",
    "layerPoint",
    "latlng"
  ]

  fields.forEach((field) => {
    if (field in sourceEvent) {
      clone[field] = sourceEvent[field]
    }
  })

  return clone
}

function patchLeafletFirefoxMouseWarnings(map) {
  if (!map || map.__pepePatchedDomFireEvent) {
    return
  }

  map.__pepePatchedDomFireEvent = true
  map._fireDOMEvent = function patchedFireDomEvent(e, type, canvasTargets) {
    if (e?.type === "click") {
      const synth = clonePreclickEvent(e)
      this._fireDOMEvent(synth, synth.type, canvasTargets)
    }

    let targets = this._findEventTargets(e, type)

    if (canvasTargets) {
      const filtered = []
      for (let i = 0; i < canvasTargets.length; i += 1) {
        if (canvasTargets[i].listens(type, true)) {
          filtered.push(canvasTargets[i])
        }
      }
      targets = filtered.concat(targets)
    }

    if (!targets.length) {
      return
    }

    if (type === "contextmenu") {
      L.DomEvent.preventDefault(e)
    }

    const target = targets[0]
    const data = { originalEvent: e }

    if (e.type !== "keypress" && e.type !== "keydown" && e.type !== "keyup") {
      const isMarker = target.getLatLng && (!target._radius || target._radius <= 10)
      data.containerPoint = isMarker
        ? this.latLngToContainerPoint(target.getLatLng())
        : this.mouseEventToContainerPoint(e)
      data.layerPoint = this.containerPointToLayerPoint(data.containerPoint)
      data.latlng = isMarker ? target.getLatLng() : this.layerPointToLatLng(data.layerPoint)
    }

    for (let i = 0; i < targets.length; i += 1) {
      targets[i].fire(type, data, true)
      if (
        data.originalEvent?._stopped ||
        (targets[i].options.bubblingMouseEvents === false && this._mouseEvents.indexOf(type) !== -1)
      ) {
        return
      }
    }
  }
}

function getSearchText(marker) {
  return [marker.name, marker.description, marker.type].map(readString).join(" ").toLowerCase()
}

function readCookie(name) {
  const source = typeof document === "undefined" ? "" : document.cookie || ""
  const key = `${name}=`
  const entry = source
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(key))

  if (!entry) {
    return ""
  }

  try {
    return decodeURIComponent(entry.slice(key.length))
  } catch {
    return ""
  }
}

function writeCookie(name, value, maxAgeSeconds = MAP_VIEW_COOKIE_MAX_AGE) {
  if (typeof document === "undefined") {
    return
  }

  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`
}

function readSavedMapViews() {
  try {
    const raw = readCookie(MAP_VIEW_COOKIE_NAME)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeSavedMapViews(payload) {
  writeCookie(MAP_VIEW_COOKIE_NAME, JSON.stringify(payload))
}

function getMapViewStorageKey(worldId, dimensionId) {
  return `${readString(worldId) || "world"}::${readString(dimensionId) || "overworld"}`
}

function normalizeBridgeDimension(value) {
  const source = readString(value).toLowerCase()
  if (!source) {
    return ""
  }

  if (source.includes("nether") || source.includes("the_nether") || source.includes("ад")) {
    return "nether"
  }

  if (source.includes("end") || source.includes("the_end") || source.includes("энд")) {
    return "end"
  }

  if (source.includes("pale") || source.includes("блед")) {
    return "pale"
  }

  return "overworld"
}

function readMinecraftUrlState(locationLike = window.location) {
  if (!locationLike) {
    return null
  }

  const params = new URLSearchParams(locationLike.search || "")
  const rawX = readString(params.get("x"))
  const rawZ = readString(params.get("z"))
  if (!rawX || !rawZ) {
    return null
  }

  const x = Number(rawX)
  const z = Number(rawZ)
  const dimension = normalizeBridgeDimension(params.get("dimension"))
  const worldId = readString(locationLike.pathname).replace(/^\/+|\/+$/g, "")

  if (!worldId || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null
  }

  return {
    world: worldId,
    dimension: dimension || "overworld",
    x,
    z
  }
}

function getMinecraftDimensionId(dimensionId) {
  if (dimensionId === "nether") return "minecraft:the_nether"
  if (dimensionId === "end") return "minecraft:the_end"
  if (dimensionId === "pale") return "pw:pale_garden"
  return "minecraft:overworld"
}

function createTeleportCommand(dimensionId, x, z) {
  return `/execute in ${getMinecraftDimensionId(dimensionId)} run tp @s ${x} ~ ${z}`
}

function createMapShareUrl(origin, worldId, dimensionId, x, z, version) {
  const url = new URL(`/s/${worldId}/${dimensionId}/${x}/${z}`, origin)
  if (version) url.searchParams.set("v", String(version))
  return url.toString()
}

function getExpandedViewportRect(map, worldMeta, paddingPx = 0) {
  if (!map || !worldMeta) {
    return null
  }

  const bounds = map.getBounds()
  return {
    left: clampNumeric(bounds.getWest() - paddingPx, 0, worldMeta.width, 0),
    right: clampNumeric(bounds.getEast() + paddingPx, 0, worldMeta.width, worldMeta.width),
    top: clampNumeric(worldMeta.height - bounds.getNorth() - paddingPx, 0, worldMeta.height, 0),
    bottom: clampNumeric(worldMeta.height - bounds.getSouth() + paddingPx, 0, worldMeta.height, worldMeta.height)
  }
}

function isMarkerInsideViewport(marker, viewportRect) {
  if (!marker || !viewportRect) {
    return false
  }

  return (
    marker.localX >= viewportRect.left &&
    marker.localX <= viewportRect.right &&
    marker.localZ >= viewportRect.top &&
    marker.localZ <= viewportRect.bottom
  )
}

export default function PepeMapsSite() {
  const mapHostRef = useRef(null)
  const mapRef = useRef(null)
  const tileLayerGroupRef = useRef(null)
  const previewLayerGroupRef = useRef(null)
  const overviewLayerRef = useRef(null)
  const detailModeRef = useRef(false)
  const previewModeRef = useRef(false)
  const markerLayerGroupRef = useRef(null)
  const mapActionMenuRef = useRef(null)
  const tileEntriesRef = useRef(new Map())
  const tileQueueRef = useRef({ pending: [], active: 0, pump: () => {} })
  const previewEntriesRef = useRef(new Map())
  const previewQueueRef = useRef({ pending: [], active: 0, pump: () => {} })
  const markerEntriesRef = useRef(new Map())
  const fitZoomRef = useRef(0)
  const worldMetaRef = useRef(null)
  const activeWorldIdRef = useRef(DEFAULT_CATALOG.defaultWorldId)
  const activeDimensionIdRef = useRef(DEFAULT_CATALOG.defaultDimensionId)
  const urlMinecraftStateRef = useRef(null)
  const viewportFrameRef = useRef(0)
  const lastViewportPositionRef = useRef(null)
  const copyTimerRef = useRef(0)
  const saveViewTimerRef = useRef(0)
  const isViewReadyRef = useRef(false)

  const [catalog, setCatalog] = useState(DEFAULT_CATALOG)
  const [catalogError, setCatalogError] = useState("")
  const [activeWorldId, setActiveWorldId] = useState(DEFAULT_CATALOG.defaultWorldId)
  const [activeDimensionId, setActiveDimensionId] = useState(DEFAULT_CATALOG.defaultDimensionId)
  const [manifest, setManifest] = useState(null)
  const [markers, setMarkers] = useState([])
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState("")
  const [showMarkers, setShowMarkers] = useState(true)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [zoomPercent, setZoomPercent] = useState(100)
  const [viewportToken, setViewportToken] = useState(0)
  const [copiedMarkerId, setCopiedMarkerId] = useState("")
  const [copyMessage, setCopyMessage] = useState("")
  const [mapActionMenu, setMapActionMenu] = useState(null)
  const [markerVisibilityThreshold, setMarkerVisibilityThreshold] = useState(8)
  const [viewportRect, setViewportRect] = useState(null)
  const [failedOverviewUrl, setFailedOverviewUrl] = useState("")

  const activeWorld = useMemo(
    () => (Array.isArray(catalog.worlds) ? catalog.worlds.find((world) => world.id === activeWorldId) : null) || null,
    [activeWorldId, catalog.worlds]
  )
  const activeDimension = useMemo(
    () => (Array.isArray(activeWorld?.dimensions) ? activeWorld.dimensions.find((dimension) => dimension.id === activeDimensionId) : null) || null,
    [activeDimensionId, activeWorld]
  )
  const tileMeta = useMemo(() => buildTileMeta(manifest), [manifest])
  const previewTiles = useMemo(() => buildPreviewTiles(manifest, tileMeta), [manifest, tileMeta])
  const worldMeta = useMemo(() => createWorldMeta(tileMeta, manifest), [manifest, tileMeta])
  const overviewUrl = getOverviewUrl(activeDimension?.manifestPath || activeWorld?.manifestPath, manifest?.generatedAt)
  const worldMarkers = useMemo(() => {
    if (!worldMeta) {
      return []
    }

    return (Array.isArray(markers) ? markers : [])
      .filter((marker) => marker.world === activeWorldId && marker.dimension === activeDimensionId && !marker.disabled)
      .map((marker) => {
        const localX = marker.x - worldMeta.minX
        const localZ = marker.z - worldMeta.minZ
        return {
          ...marker,
          localX,
          localZ,
          latlng: toLatLng(localX, localZ, worldMeta),
          searchText: getSearchText(marker)
        }
      })
  }, [activeDimensionId, activeWorldId, markers, worldMeta])
  const visibleMarkers = useMemo(
    () => worldMarkers.filter((marker) => getMarkerWeight(marker) >= markerVisibilityThreshold),
    [markerVisibilityThreshold, worldMarkers]
  )
  const viewportMarkers = useMemo(() => {
    if (!viewportRect) {
      return visibleMarkers
    }

    return visibleMarkers.filter((marker) => isMarkerInsideViewport(marker, viewportRect))
  }, [viewportRect, visibleMarkers])
  const normalizedQuery = readString(searchQuery).toLowerCase()
  const searchResults = useMemo(() => {
    if (!normalizedQuery) {
      return []
    }

    return worldMarkers
      .filter((marker) => marker.searchText.includes(normalizedQuery))
      .slice(0, SEARCH_RESULTS_LIMIT)
  }, [normalizedQuery, worldMarkers])
  const searchHasQuery = normalizedQuery.length > 0
  const statusWorldLabel = readString(activeWorld?.label) || "Мир"

  useEffect(() => {
    worldMetaRef.current = worldMeta
  }, [worldMeta])

  useEffect(() => {
    activeWorldIdRef.current = activeWorldId
    activeDimensionIdRef.current = activeDimensionId
  }, [activeDimensionId, activeWorldId])

  useEffect(() => {
    document.title = "Pepe-Maps"
    const description = document.querySelector('meta[name="description"]')
    if (description) {
      description.setAttribute("content", "Pepe-Maps: интерактивная карта миров PepeLand")
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    urlMinecraftStateRef.current = readMinecraftUrlState()
  }, [])

  useEffect(() => {
    const dismiss = (event) => {
      if (!mapActionMenuRef.current?.contains(event.target)) setMapActionMenu(null)
    }
    const dismissOnEscape = (event) => {
      if (event.key === "Escape") setMapActionMenu(null)
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [])

  useEffect(() => {
    setMapActionMenu(null)
  }, [activeWorldId, activeDimensionId])

  useEffect(() => {
    const onPopState = () => {
      const worldId = getWorldIdFromPathname(window.location.pathname, catalog.worlds)
      const minecraftUrlState = readMinecraftUrlState(window.location)
      urlMinecraftStateRef.current = minecraftUrlState
      if (worldId) {
        setActiveWorldId(worldId)
        const nextWorld = (catalog.worlds || []).find((world) => world.id === worldId) || null
        const nextDimensionId =
          minecraftUrlState?.dimension &&
          Array.isArray(nextWorld?.dimensions) &&
          nextWorld.dimensions.some((dimension) => dimension.id === minecraftUrlState.dimension && dimension.enabled)
            ? minecraftUrlState.dimension
            : getFirstEnabledDimension(nextWorld, catalog.defaultDimensionId || DEFAULT_CATALOG.defaultDimensionId)
        setActiveDimensionId(nextDimensionId)
        if (
          minecraftUrlState &&
          worldId === activeWorldIdRef.current &&
          nextDimensionId === activeDimensionIdRef.current &&
          worldMetaRef.current
        ) {
          mapRef.current?.flyTo(
            markerToLatLng(minecraftUrlState, worldMetaRef.current),
            Math.max(mapRef.current.getZoom(), fitZoomRef.current + 1.35),
            { duration: 0.55 }
          )
        }
      }
      setMapActionMenu(null)
    }

    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [catalog.defaultDimensionId, catalog.worlds])

  useEffect(() => {
    let cancelled = false

    const loadCatalog = async () => {
      try {
        const payload = await fetchJsonFile("/maps/catalog.json")
        if (cancelled) {
          return
        }

        const nextCatalog = payload && typeof payload === "object" ? payload : DEFAULT_CATALOG
        setCatalog(nextCatalog)
        setCatalogError("")

        const savedViews = readSavedMapViews()
        const lastSavedView = Object.values(savedViews)
          .filter((item) => item && typeof item === "object")
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
        const minecraftUrlState = readMinecraftUrlState(window.location)
        urlMinecraftStateRef.current = minecraftUrlState
        const urlWorldId = getWorldIdFromPathname(window.location.pathname, nextCatalog.worlds)
        const defaultWorldId = nextCatalog.defaultWorldId || DEFAULT_CATALOG.defaultWorldId
        const nextWorldId = readString(urlWorldId) || readString(minecraftUrlState?.world) || readString(lastSavedView?.worldId) || defaultWorldId

        setActiveWorldId(nextWorldId)
        const initialWorld = Array.isArray(nextCatalog.worlds)
          ? nextCatalog.worlds.find((world) => world.id === nextWorldId)
          : null
        const urlDimensionId = readString(minecraftUrlState?.dimension)
        const preferredDimensionId = readString(lastSavedView?.dimensionId)
        const initialDimensionId =
          urlDimensionId &&
          Array.isArray(initialWorld?.dimensions) &&
          initialWorld.dimensions.some((dimension) => dimension.id === urlDimensionId && dimension.enabled)
            ? urlDimensionId
            : preferredDimensionId &&
          Array.isArray(initialWorld?.dimensions) &&
          initialWorld.dimensions.some((dimension) => dimension.id === preferredDimensionId && dimension.enabled)
            ? preferredDimensionId
            : getFirstEnabledDimension(initialWorld, nextCatalog.defaultDimensionId || DEFAULT_CATALOG.defaultDimensionId)
        setActiveDimensionId(initialDimensionId)
      } catch (error) {
        if (!cancelled) {
          setCatalog(DEFAULT_CATALOG)
          setCatalogError("Не удалось загрузить каталог миров.")
        }
      }
    }

    loadCatalog()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeWorld) {
      return
    }

    if (!activeDimension?.enabled) {
      setActiveDimensionId(getFirstEnabledDimension(activeWorld, catalog.defaultDimensionId || DEFAULT_CATALOG.defaultDimensionId))
    }
  }, [activeDimension?.enabled, activeWorld, catalog.defaultDimensionId])

  useEffect(() => {
    if (!activeWorld || activeWorld.status !== "active" || !activeDimension?.enabled) {
      setManifest(null)
      setMarkers([])
      setMapLoading(false)
      return
    }

    let cancelled = false
    setMapLoading(true)
    setMapError("")

    const loadWorld = async () => {
      try {
        const manifestPath = activeDimension.manifestPath || activeWorld.manifestPath
        const [rawManifestPayload, markerPayload, previewPayload] = await Promise.all([
          fetchJsonFile(manifestPath),
          activeWorld.markersPath ? fetchJsonFile(activeWorld.markersPath).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
          fetchJsonFile(manifestPath.replace(/manifest\.json$/, "previews.json")).catch(() => ({ tiles: [] }))
        ])
        if (cancelled) {
          return
        }

        const manifestPayload = resolveManifestForDimension(rawManifestPayload, activeWorld.id, activeDimensionId)
        const markerItems = Array.isArray(markerPayload?.item?.items)
          ? markerPayload.item.items
          : Array.isArray(markerPayload?.items)
            ? markerPayload.items
            : []

        setManifest({ ...manifestPayload, previewTiles: previewPayload.tiles })
        setMarkers(markerItems.filter((marker) => readString(marker?.dimension) === activeDimensionId))
      } catch (error) {
        if (!cancelled) {
          setManifest(null)
          setMarkers([])
          setMapError(error instanceof Error ? error.message : "Не удалось загрузить карту мира.")
        }
      } finally {
        if (!cancelled) {
          setMapLoading(false)
        }
      }
    }

    loadWorld()
    return () => {
      cancelled = true
    }
  }, [activeDimension?.enabled, activeDimensionId, activeWorld])

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) {
      return undefined
    }

    const map = L.map(mapHostRef.current, {
      crs: L.CRS.Simple,
      attributionControl: false,
      zoomControl: false,
      preferCanvas: true,
      zoomSnap: 0.05,
      zoomDelta: 0.3,
      doubleClickZoom: true,
      inertia: true,
      maxBoundsViscosity: 1
    })
    map.setView([0, 0], 0, { animate: false })

    map.createPane("overview")
    map.getPane("overview").style.zIndex = "190"
    map.createPane("previews")
    map.getPane("previews").style.zIndex = "195"
    map.createPane("tiles")
    map.getPane("tiles").style.zIndex = "200"
    map.createPane("markers")
    map.getPane("markers").style.zIndex = "620"
    patchLeafletFirefoxMouseWarnings(map)

    tileLayerGroupRef.current = L.layerGroup().addTo(map)
    previewLayerGroupRef.current = L.layerGroup().addTo(map)
    markerLayerGroupRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    const openMapActionMenu = (event) => {
      const meta = worldMetaRef.current
      if (!meta || !isViewReadyRef.current) return

      const localX = event.latlng.lng
      const localZ = meta.height - event.latlng.lat
      if (localX < 0 || localX >= meta.width || localZ < 0 || localZ >= meta.height) return

      const pointer = event.originalEvent
      const rect = map.getContainer().getBoundingClientRect()
      const clientX = Number.isFinite(pointer?.clientX) ? pointer.clientX : rect.left + event.containerPoint.x
      const clientY = Number.isFinite(pointer?.clientY) ? pointer.clientY : rect.top + event.containerPoint.y
      setMapActionMenu({
        x: Math.floor(meta.minX + localX),
        z: Math.floor(meta.minZ + localZ),
        worldId: activeWorldIdRef.current,
        dimensionId: activeDimensionIdRef.current,
        left: Math.max(8, Math.min(clientX + 10, window.innerWidth - 108)),
        top: Math.max(8, Math.min(clientY + 10, window.innerHeight - 62))
      })
    }
    const closeMapActionMenu = () => setMapActionMenu(null)
    const clearSharedLocationOnDrag = () => {
      if (!urlMinecraftStateRef.current) return
      urlMinecraftStateRef.current = null
      window.history.replaceState(window.history.state, "", window.location.pathname)
    }
    map.on("contextmenu", openMapActionMenu)
    map.on("movestart zoomstart", closeMapActionMenu)
    map.on("dragstart", clearSharedLocationOnDrag)

    const syncViewport = () => {
      if (viewportFrameRef.current) {
        return
      }

      viewportFrameRef.current = window.requestAnimationFrame(() => {
        viewportFrameRef.current = 0
        if (!isViewReadyRef.current || !worldMetaRef.current) return
        const zoom = map.getZoom()
        lastViewportPositionRef.current = { center: map.project(map.getCenter(), zoom), zoom }
        const nextViewportRect = worldMetaRef.current
          ? getExpandedViewportRect(map, worldMetaRef.current, MARKER_VIEW_PADDING_PX)
          : null
        setViewportRect((previous) => {
          if (
            previous &&
            nextViewportRect &&
            previous.left === nextViewportRect.left &&
            previous.right === nextViewportRect.right &&
            previous.top === nextViewportRect.top &&
            previous.bottom === nextViewportRect.bottom
          ) {
            return previous
          }
          return nextViewportRect
        })
        setViewportToken((previous) => previous + 1)
        if (Number.isFinite(fitZoomRef.current)) {
          setZoomPercent(Math.round(map.getZoomScale(map.getZoom(), fitZoomRef.current) * 100))
          setMarkerVisibilityThreshold(getMarkerVisibilityThreshold(map.getZoom(), fitZoomRef.current))
        }
      })
    }

    const syncAfterLongPan = () => {
      if (!isViewReadyRef.current || !lastViewportPositionRef.current) return
      const zoom = map.getZoom()
      if (Math.abs(zoom - lastViewportPositionRef.current.zoom) > 0.01) return
      const center = map.project(map.getCenter(), zoom)
      if (
        Math.abs(center.x - lastViewportPositionRef.current.center.x) >= 128 ||
        Math.abs(center.y - lastViewportPositionRef.current.center.y) >= 128
      ) syncViewport()
    }

    map.on("move", syncAfterLongPan)
    map.on("moveend zoomend resize load", syncViewport)

    const persistView = () => {
      if (!isViewReadyRef.current || !worldMetaRef.current) {
        return
      }

      if (saveViewTimerRef.current) {
        window.clearTimeout(saveViewTimerRef.current)
      }

      saveViewTimerRef.current = window.setTimeout(() => {
        const currentMap = mapRef.current
        const currentWorldMeta = worldMetaRef.current
        if (!currentMap || !currentWorldMeta || !currentMap._loaded) {
          return
        }

        const center = currentMap.getCenter()
        const savedViews = readSavedMapViews()
        const storageKey = getMapViewStorageKey(activeWorldIdRef.current, activeDimensionIdRef.current)
        savedViews[storageKey] = {
          worldId: activeWorldIdRef.current,
          dimensionId: activeDimensionIdRef.current,
          zoom: Number(currentMap.getZoom().toFixed(4)),
          x: Number(center.lng.toFixed(2)),
          y: Number(center.lat.toFixed(2)),
          updatedAt: Date.now()
        }
        writeSavedMapViews(savedViews)
      }, 220)
    }

    map.on("moveend zoomend", persistView)

    return () => {
      if (viewportFrameRef.current) {
        window.cancelAnimationFrame(viewportFrameRef.current)
      }
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current)
      }
      if (saveViewTimerRef.current) {
        window.clearTimeout(saveViewTimerRef.current)
      }
      map.off("move", syncAfterLongPan)
      map.off("moveend zoomend resize load", syncViewport)
      map.off("moveend zoomend", persistView)
      map.off("contextmenu", openMapActionMenu)
      map.off("movestart zoomstart", closeMapActionMenu)
      map.off("dragstart", clearSharedLocationOnDrag)
      map.remove()
      mapRef.current = null
      lastViewportPositionRef.current = null
      overviewLayerRef.current = null
      tileEntriesRef.current.clear()
      tileQueueRef.current = { pending: [], active: 0, pump: () => {} }
      previewEntriesRef.current.clear()
      previewQueueRef.current = { pending: [], active: 0, pump: () => {} }
      markerEntriesRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !worldMeta) {
      return
    }

    isViewReadyRef.current = false
    let cancelled = false
    let frame = 0

    const syncInitialView = (attempt = 0) => {
      if (cancelled) {
        return
      }

      map.invalidateSize(false)
      const size = map.getSize()
      if (!size?.x || !size?.y || !Number.isFinite(size.x) || !Number.isFinite(size.y)) {
        if (attempt < 12) {
          frame = window.requestAnimationFrame(() => syncInitialView(attempt + 1))
        }
        return
      }

      map.setMaxBounds(worldMeta.maxBounds)
      map.setMinZoom(-10)
      map.fitBounds(worldMeta.bounds, { animate: false, padding: [60, 60] })
      const fitZoom = map.getZoom()
      fitZoomRef.current = fitZoom
      map.setMaxZoom(fitZoom + 6.5)
      const savedViews = readSavedMapViews()
      const storageKey = getMapViewStorageKey(activeWorldId, activeDimensionId)
      const savedView = savedViews[storageKey]
      const minecraftUrlState = urlMinecraftStateRef.current
      const hasMinecraftUrlState =
        minecraftUrlState &&
        readString(minecraftUrlState.world) === activeWorldId &&
        readString(minecraftUrlState.dimension || "overworld") === activeDimensionId &&
        Number.isFinite(Number(minecraftUrlState.x)) &&
        Number.isFinite(Number(minecraftUrlState.z))
      const hasSavedView =
        savedView &&
        Number.isFinite(Number(savedView.x)) &&
        Number.isFinite(Number(savedView.y)) &&
        Number.isFinite(Number(savedView.zoom))

      if (hasMinecraftUrlState) {
        const localX = minecraftUrlState.x - worldMeta.minX
        const localZ = minecraftUrlState.z - worldMeta.minZ
        map.setView(
          toLatLng(localX, localZ, worldMeta),
          clampNumeric(fitZoom + 1.35, -10, fitZoom + 6.5, fitZoom + 1.35),
          { animate: false }
        )
      } else if (hasSavedView) {
        map.setView(
          L.latLng(
            clampNumeric(savedView.y, worldMeta.maxBounds.getSouth(), worldMeta.maxBounds.getNorth(), worldMeta.height / 2),
            clampNumeric(savedView.x, worldMeta.maxBounds.getWest(), worldMeta.maxBounds.getEast(), worldMeta.width / 2)
          ),
          clampNumeric(savedView.zoom, -10, fitZoom + 6.5, fitZoom),
          { animate: false }
        )
      } else {
        const targetZoom = clampNumeric(
          Math.max(0, fitZoom) + Math.log2(window.innerWidth <= 860 ? 1.55 : 1.18),
          -10,
          fitZoom + 6.5,
          fitZoom
        )
        map.setView(
          toLatLng(worldMeta.focusX * worldMeta.width, worldMeta.focusY * worldMeta.height, worldMeta),
          targetZoom,
          { animate: false }
        )
      }
      isViewReadyRef.current = true
      lastViewportPositionRef.current = { center: map.project(map.getCenter(), map.getZoom()), zoom: map.getZoom() }
      setZoomPercent(Math.round(map.getZoomScale(map.getZoom(), fitZoom) * 100))
      setMarkerVisibilityThreshold(getMarkerVisibilityThreshold(map.getZoom(), fitZoom))
      setViewportRect(getExpandedViewportRect(map, worldMeta, MARKER_VIEW_PADDING_PX))
      setViewportToken((previous) => previous + 1)
    }

    frame = window.requestAnimationFrame(() => syncInitialView())

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [activeDimensionId, activeWorldId, worldMeta])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !worldMeta || !overviewUrl) return undefined

    const layer = L.imageOverlay(overviewUrl, worldMeta.bounds, {
      pane: "overview",
      interactive: false,
      className: "pepe-map-overview"
    })
    layer.on("load", () => {
      const element = layer.getElement()
      if (!element) return
      const center = map.getCenter()
      element.style.setProperty("--reveal-x", `${clampNumeric(center.lng / worldMeta.width * 100, 0, 100, 50)}%`)
      element.style.setProperty("--reveal-y", `${clampNumeric((worldMeta.height - center.lat) / worldMeta.height * 100, 0, 100, 50)}%`)
      window.requestAnimationFrame(() => element.classList.add("is-loaded"))
    })
    layer.on("error", () => setFailedOverviewUrl(overviewUrl))
    layer.addTo(map)
    overviewLayerRef.current = layer

    return () => {
      map.removeLayer(layer)
      if (overviewLayerRef.current === layer) overviewLayerRef.current = null
    }
  }, [overviewUrl, worldMeta])

  useEffect(() => {
    const map = mapRef.current
    const tileLayerGroup = tileLayerGroupRef.current
    if (!map || !tileLayerGroup) {
      return
    }

    isViewReadyRef.current = false
    lastViewportPositionRef.current = null
    detailModeRef.current = false
    previewModeRef.current = false
    tileEntriesRef.current.forEach(({ layer }) => tileLayerGroup.removeLayer(layer))
    tileEntriesRef.current.clear()
    tileQueueRef.current = { pending: [], active: 0, pump: () => {} }
    previewEntriesRef.current.forEach(({ layer }) => previewLayerGroupRef.current?.removeLayer(layer))
    previewEntriesRef.current.clear()
    previewQueueRef.current = { pending: [], active: 0, pump: () => {} }
    setViewportRect(null)
    setViewportToken((previous) => previous + 1)
  }, [tileMeta.signature])

  useEffect(() => {
    const map = mapRef.current
    const tileLayerGroup = tileLayerGroupRef.current
    const previewLayerGroup = previewLayerGroupRef.current
    if (!map || !tileLayerGroup || !previewLayerGroup || !worldMeta || !tileMeta.enabled || !isViewReadyRef.current || !map._loaded) {
      return
    }

    const zoomDelta = map.getZoom() - fitZoomRef.current
    const usePreview = previewTiles.length > 0 && (previewModeRef.current
      ? zoomDelta >= PREVIEW_ZOOM_EXIT
      : zoomDelta >= PREVIEW_ZOOM_ENTER)
    const useDetail = failedOverviewUrl === overviewUrl || (previewTiles.length === 0 && zoomDelta >= PREVIEW_ZOOM_ENTER) || (detailModeRef.current
        ? zoomDelta >= DETAIL_ZOOM_EXIT
        : zoomDelta >= DETAIL_ZOOM_ENTER)
    previewModeRef.current = usePreview
    detailModeRef.current = useDetail
    const visibleRect = getExpandedViewportRect(map, worldMeta, TILE_VIEW_PADDING_PX)
    reconcileImageLayers({
      map, worldMeta, tiles: previewTiles, visibleRect: usePreview ? visibleRect : null,
      layerGroup: previewLayerGroup, entriesRef: previewEntriesRef, queueRef: previewQueueRef,
      pane: "previews", className: "pepe-map-preview", maxRequests: MAX_PREVIEW_REQUESTS
    })
    reconcileImageLayers({
      map, worldMeta, tiles: tileMeta.tiles, visibleRect: useDetail ? visibleRect : null,
      layerGroup: tileLayerGroup, entriesRef: tileEntriesRef, queueRef: tileQueueRef,
      pane: "tiles", className: "pepe-map-tile", maxRequests: MAX_TILE_REQUESTS
    })
  }, [failedOverviewUrl, overviewUrl, previewTiles, tileMeta, viewportToken, worldMeta])

  const focusMarker = useCallback((marker) => {
    const map = mapRef.current
    if (!map || !worldMeta) {
      return
    }

    map.flyTo(
      markerToLatLng(marker, worldMeta),
      Math.max(map.getZoom(), (fitZoomRef.current || map.getZoom()) + 1.65),
      { animate: true, duration: 0.65 }
    )
  }, [worldMeta])

  const focusCluster = useCallback((cluster) => {
    const map = mapRef.current
    if (!map || !cluster) {
      return
    }

    map.flyTo(cluster.latlng, Math.min(map.getZoom() + 1.2, map.getMaxZoom()), {
      animate: true,
      duration: 0.55
    })
  }, [])

  const onCopyMarker = useCallback(async (marker) => {
    const text = `X ${Math.round(marker.x)} Z ${Math.round(marker.z)}`
    try {
      await copyTextToClipboard(text)
      setCopiedMarkerId(marker.id)
      setCopyMessage(`Скопировано: ${text}`)
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedMarkerId("")
        setCopyMessage("")
      }, 1800)
    } catch (error) {
      setCopyMessage("Не удалось скопировать координаты")
    }
  }, [])

  const onCopyMapAction = async (action) => {
    if (!mapActionMenu) return

    const { x, z, worldId, dimensionId } = mapActionMenu
    const value = action === "command"
      ? createTeleportCommand(dimensionId, x, z)
      : createMapShareUrl(window.location.origin, worldId, dimensionId, x, z, manifest?.generatedAt)

    try {
      await copyTextToClipboard(value)
      setCopyMessage(action === "command" ? `Команда скопирована: ${value}` : "Ссылка на место скопирована")
    } catch {
      setCopyMessage("Не удалось скопировать")
    }

    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => setCopyMessage(""), 2600)
    setMapActionMenu(null)
  }

  useEffect(() => {
    const map = mapRef.current
    const markerLayerGroup = markerLayerGroupRef.current
    if (!markerLayerGroup || !map) {
      return
    }

    if (!showMarkers || !worldMeta) {
      markerEntriesRef.current.forEach((layer) => {
        const markerNode = layer.getElement()?.querySelector(".pepe-map-marker")
        if (markerNode) {
          markerNode.classList.remove("is-visible")
          markerNode.classList.add("is-hiding")
        }
        window.setTimeout(() => {
          markerLayerGroup.removeLayer(layer)
        }, 150)
      })
      markerEntriesRef.current.clear()
      return
    }

    const displayMarkers = clusterMarkersForViewport(viewportMarkers, worldMeta, map, fitZoomRef.current || map.getZoom())
    const nextIds = new Set(displayMarkers.map((entry) => entry.id))

    markerEntriesRef.current.forEach((layer, markerId) => {
      if (nextIds.has(markerId)) {
        return
      }

      const markerNode = layer.getElement()?.querySelector(".pepe-map-marker")
      if (markerNode) {
        markerNode.classList.remove("is-visible")
        markerNode.classList.add("is-hiding")
      }
      window.setTimeout(() => markerLayerGroup.removeLayer(layer), 150)
      markerEntriesRef.current.delete(markerId)
    })

    displayMarkers.forEach((entry) => {
      const existingLayer = markerEntriesRef.current.get(entry.id)
      const latlng = entry.kind === "cluster" ? entry.latlng : markerToLatLng(entry.marker, worldMeta)
      if (existingLayer) {
        existingLayer.setLatLng(latlng)
        const markerNode = existingLayer.getElement()?.querySelector(".pepe-map-marker")
        if (markerNode) {
          markerNode.classList.add("is-visible")
          markerNode.classList.remove("is-hiding")
        }
        return
      }

      const layer = L.marker(latlng, {
        pane: "markers",
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: entry.kind === "cluster" ? 160 : entry.marker.type === "portal" ? 120 : 80,
        icon: entry.kind === "cluster" ? createClusterIcon(entry) : createMarkerIcon(entry.marker)
      })
      layer.on("click", (event) => {
        if (event.originalEvent) {
          L.DomEvent.stop(event.originalEvent)
        }
        if (entry.kind === "cluster") {
          focusCluster(entry)
          return
        }
        onCopyMarker(entry.marker)
      })
      layer.on("dblclick", (event) => {
        if (event.originalEvent) {
          L.DomEvent.stop(event.originalEvent)
        }
        if (entry.kind === "cluster") {
          focusCluster(entry)
          return
        }
        focusMarker(entry.marker)
      })
      layer.addTo(markerLayerGroup)
      markerEntriesRef.current.set(entry.id, layer)
      window.requestAnimationFrame(() => {
        const markerNode = layer.getElement()?.querySelector(".pepe-map-marker")
        if (markerNode) {
          markerNode.classList.add("is-visible")
        }
      })
    })
  }, [focusCluster, focusMarker, onCopyMarker, showMarkers, viewportMarkers, viewportToken, worldMeta])

  useEffect(() => {
    markerEntriesRef.current.forEach((layer, markerId) => {
      const element = layer.getElement()
      const markerNode = element?.querySelector(".pepe-map-marker")
      if (!markerNode) {
        return
      }

      markerNode.classList.toggle("is-copied", markerId === copiedMarkerId)
    })
  }, [copiedMarkerId])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      map.invalidateSize(false)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [isMenuOpen, searchHasQuery])

  const onWorldClick = (world) => {
    if (!world || world.status !== "active") {
      return
    }

    setActiveWorldId(world.id)
    setActiveDimensionId(getFirstEnabledDimension(world, catalog.defaultDimensionId || "overworld"))
    setSearchQuery("")
    setIsMenuOpen(false)
    urlMinecraftStateRef.current = null
    if (window.location.pathname !== `/${world.id}` || window.location.search) {
      window.history.pushState({}, "", `/${world.id}`)
    }
  }

  const onDimensionClick = (dimension) => {
    if (!dimension?.enabled) {
      return
    }

    setActiveDimensionId(dimension.id)
    setSearchQuery("")
    urlMinecraftStateRef.current = null
    if (window.location.search) {
      window.history.replaceState({}, "", `/${activeWorldId}`)
    }
  }

  const onSearchSubmit = (event) => {
    event.preventDefault()
    if (searchResults.length > 0) {
      focusMarker(searchResults[0])
    }
  }

  const zoomIn = () => {
    mapRef.current?.zoomIn(0.65)
  }

  const zoomOut = () => {
    mapRef.current?.zoomOut(0.65)
  }

  return (
    <div className="pepe-app">
      <div ref={mapHostRef} className="pepe-map-canvas" />
      <div className="pepe-map-vignette" aria-hidden="true" />

      {mapActionMenu && (
        <div
          ref={mapActionMenuRef}
          className="pepe-map-actions"
          role="toolbar"
          aria-label={`Действия для X ${mapActionMenu.x} Z ${mapActionMenu.z}`}
          style={{ left: mapActionMenu.left, top: mapActionMenu.top }}
        >
          <button
            type="button"
            className="pepe-map-action"
            onClick={() => onCopyMapAction("command")}
            aria-label="Копировать команду телепортации в Minecraft"
            title="Копировать /execute (Y останется текущим)"
          >
            <span aria-hidden="true">/</span>
          </button>
          <button
            type="button"
            className="pepe-map-action"
            onClick={() => onCopyMapAction("link")}
            aria-label="Копировать ссылку на это место"
            title="Копировать ссылку на это место"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 4.5 20 10l-6 5.5V12c-5 0-8.2 2.2-10 7 0-7.4 3.7-11 10-11V4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div className="pepe-topbar">
        <div className="pepe-brand-card" tabIndex={0}>
          <span className="pepe-brand-icon" aria-hidden="true">
            <svg width="458" height="458" viewBox="0 0 458 458" fill="none">
              <g clipPath="url(#pepeBrandClip)">
                <path d="M333.594 0C402.025 0 457.5 55.475 457.5 123.906v209.688c0 68.431-55.475 123.906-123.906 123.906H123.706q-.852-.001-1.701-.015c-38.029-.572-71.905-18.275-94.253-45.735q-.2-.246-.397-.494C10.243 390.01 0 362.998 0 333.594V123.906C0 55.475 55.475 0 123.906 0zM54.756 313.045c0 8.953-7.258 16.211-16.211 16.211H24.36c-2.253 0-4.4-.46-6.35-1.291v5.629c0 25.147 8.744 48.203 23.37 66.364l.002.002.33.41.01.011c19.128 23.504 48.067 38.606 80.552 39.095h.002q.73.01 1.459.012h63.91a18 18 0 0 1-.171-2.488v-30.898c0-4.844-4.14-9.157-9.395-9.157-24.809 0-45.542-20.076-45.542-45.303a8.7 8.7 0 0 0-1.963-5.496l-75.82-92.667zm69.15-286.883c-53.982 0-97.744 43.762-97.744 97.744v187.338h10.582v-75.289c0-8.953 7.258-16.211 16.211-16.211h29.54v-29.539c0-8.953 7.257-16.211 16.21-16.211h29.539v-29.539c0-8.953 7.258-16.211 16.211-16.211h77.09c8.953 0 16.211 7.258 16.211 16.211v16.569a45.8 45.8 0 0 1 13.81-2.134h9.157c1.625 0 3.228-.219 4.771-.635v-13.8c0-8.953 7.258-16.211 16.211-16.211h77.09c8.953 0 16.211 7.258 16.211 16.211v29.539h29.539c8.953 0 16.211 7.258 16.211 16.211v77.09c0 8.953-7.258 16.211-16.211 16.211h-29.539v75.289c0 1.69-.26 3.319-.739 4.851a18.23 18.23 0 0 1 2.481 9.207v5.781c0 2.292-.43 4.564-1.269 6.697-8.533 21.716-24.03 36.21-41.765 46.006 53.927-.065 97.624-43.801 97.624-97.743V123.906c0-53.982-43.762-97.744-97.744-97.744zm191.695 120.094q.056.717.057 1.449c0 7.751-1.673 14.595-6.069 20.912-1.857 2.669-3.906 4.806-5.471 6.365-.792.79-1.634 1.599-2.349 2.289-.756.73-1.467 1.419-2.201 2.153a54.94 54.94 0 0 1-38.845 16.09h-9.157a9.155 9.155 0 0 0-9.156 9.156v9.156a36.624 36.624 0 0 1-36.624 36.624v18.312a18.316 18.316 0 0 0 18.313 18.312h36.624a54.937 54.937 0 0 1 54.935 54.936c0 4.12 1.389 8.096 3.906 11.304.335.077.736.164 1.212.251 3.009.552 7.165.914 12.07 1.09 9.482.341 17.994-.047 24.148-.107v-72.843c0-8.953 7.258-16.211 16.211-16.211h29.539v-73.488h-29.539c-8.953 0-16.211-7.258-16.211-16.211v-29.539zm2.684 206.706.01.003c-.107-.047-.119-.044-.01-.003" fill="currentColor" />
              </g>
              <defs>
                <clipPath id="pepeBrandClip">
                  <rect width="457.5" height="457.5" rx="43.228" fill="#fff" />
                </clipPath>
              </defs>
            </svg>
          </span>
          <span className="pepe-brand-copy">
            <span className="pepe-brand-title">
              PepeMaps
            </span>
            <span className="pepe-brand-meta">
              <span className="pepe-ice-shimmer">{catalog.season || "10"} Сезон</span> / {statusWorldLabel}
            </span>
            <span className="pepe-brand-note">
              Данный проект не является официальной частью сети серверов{" "}
              <a href="https://pepeland.net" target="_blank" rel="noreferrer">PepeLand</a>.
            </span>
          </span>
        </div>
      </div>

      {catalog.help && <div className={`pepe-help-dock${isHelpOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="pepe-icon-btn pepe-help-btn"
          onClick={() => setIsHelpOpen((previous) => !previous)}
          aria-label={isHelpOpen ? "Закрыть блок помощи проекту" : "Открыть блок помощи проекту"}
          aria-expanded={isHelpOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 20.4 10.55 19.08C5.4 14.36 2 11.25 2 7.45 2 4.34 4.42 2 7.5 2c1.74 0 3.41.81 4.5 2.09C13.09 2.81 14.76 2 16.5 2 19.58 2 22 4.34 22 7.45c0 3.8-3.4 6.91-8.55 11.64z"
              fill="currentColor"
            />
          </svg>
        </button>

        {isHelpOpen && (
          <div className="pepe-help-card">
            <span className="pepe-help-kicker">{catalog.help.title}</span>
            <p>Ищем людей, которые:</p>
            <ul className="pepe-help-list">
              <li>знают карту сервера</li>
              <li>любят исследовать</li>
              <li>хотят помогать проекту</li>
            </ul>
            <p>
              Писать в Discord <b>{catalog.discord}</b>
            </p>
          </div>
        )}
      </div>}

      <div className="pepe-zoom-controls">
        <button type="button" onClick={zoomIn} aria-label="Приблизить">+</button>
        <button type="button" onClick={zoomOut} aria-label="Отдалить">−</button>
      </div>

      <div className={`pepe-search-dock${isMenuOpen ? " is-open" : ""}`}>
        {searchHasQuery && (
          <div className="pepe-search-results">
            <div className="pepe-search-results-head">Найденные проекты:</div>
            {searchResults.length > 0 ? (
              <div className="pepe-search-results-list">
                {searchResults.map((marker) => (
                  <button
                    key={marker.id}
                    type="button"
                    className="pepe-search-result"
                    onClick={() => {
                      focusMarker(marker)
                      setIsMenuOpen(false)
                    }}
                  >
                    <span>{marker.name}</span>
                    <small>X {Math.round(marker.x)} / Z {Math.round(marker.z)}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="pepe-search-empty">Ничего не найдено</p>
            )}
          </div>
        )}

        <div className="pepe-search-toolbar">
          <form className="pepe-search-bar" onSubmit={onSearchSubmit}>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Поиск проекта"
              aria-label="Поиск проекта"
            />
            <button type="submit" className="pepe-search-submit" aria-label="Найти проект">
              <svg viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path fillRule="evenodd" clipRule="evenodd" d="M10 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0m-.691 3.516a4.5 4.5 0 1 1 .707-.707l2.838 2.837a.5.5 0 0 1-.708.708z" fill="currentColor" />
              </svg>
            </button>
          </form>
          <button
            type="button"
            className="pepe-icon-btn pepe-menu-btn"
            onClick={() => setIsMenuOpen((previous) => !previous)}
            aria-label={isMenuOpen ? "Закрыть фильтры" : "Открыть фильтры"}
          >
            {isMenuOpen ? (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6 18 18" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
                <path d="M18 6 6 18" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 7h16" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
                <path d="M4 12h16" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
                <path d="M4 17h16" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>


        {isMenuOpen && (
          <div className="pepe-filter-panel">
            <div className="pepe-filter-group">
              <span className="pepe-filter-label"><span className="pepe-ice-shimmer">Законченные</span> миры:</span>
              <div className="pepe-chip-row">
                {catalog.worlds.map((world) => (
                  <button
                    key={world.id}
                    type="button"
                    className={`pepe-chip${activeWorldId === world.id ? " is-active" : ""}`}
                    disabled={world.status !== "active"}
                    onClick={() => onWorldClick(world)}
                  >
                    {world.shortLabel || world.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pepe-filter-group">
              <span className="pepe-filter-label">Измерение:</span>
              <div className="pepe-chip-row">
                {(activeWorld?.dimensions || []).map((dimension) => (
                  <button
                    key={dimension.id}
                    type="button"
                    className={`pepe-chip${activeDimensionId === dimension.id ? " is-active" : ""}`}
                    disabled={!dimension.enabled}
                    onClick={() => onDimensionClick(dimension)}
                  >
                    {dimension.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pepe-filter-group pepe-filter-group--switch">
              <span className="pepe-filter-label">Вид:</span>
              <label className="pepe-switch-row">
                <span>Включить маркеры</span>
                <input type="checkbox" checked={showMarkers} onChange={(event) => setShowMarkers(event.target.checked)} />
                <span className="pepe-switch-ui" aria-hidden="true"><span /></span>
              </label>
            </div>

            {catalog.discord && <p className="pepe-filter-discord">
              Связь Discord: <span>{catalog.discord}</span>
            </p>}
          </div>
        )}
      </div>

      {(mapLoading || mapError || catalogError) && (
        <div className="pepe-status-card">
          {mapLoading && <p>Загрузка карты...</p>}
          {!mapLoading && mapError && <p>{mapError}</p>}
          {!mapLoading && !mapError && catalogError && <p>{catalogError}</p>}
        </div>
      )}

      {copyMessage && <div className="pepe-copy-toast">{copyMessage}</div>}
    </div>
  )
}
