const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const SVG_START = /^(?:<\?xml\s[^?]*\?>\s*)?<svg(?=[\s/>])/
const SVG_PATH_DATA = /^[Mm][MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]*$/

export function getMarkerIconSource(value, accent) {
  const icon = typeof value === "string" ? value.trim() : ""
  if (!icon || /<!DOCTYPE/i.test(icon)) return ""

  let svg = icon
  if (!SVG_START.test(icon)) {
    const paths = /^<path(?=[\s/>])/.test(icon) ? icon
      : SVG_PATH_DATA.test(icon) ? `<path d="${icon}" fill="currentColor"/>` : ""
    if (!paths) return ""
    svg = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 16 16">${paths}</svg>`
  }

  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml")
  const root = parsed.documentElement
  if (parsed.querySelector("parsererror") || root.localName !== "svg" ||
    (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)) return ""
  if (!root.namespaceURI) root.setAttribute("xmlns", SVG_NAMESPACE)
  if (!root.hasAttribute("color")) root.setAttribute("color", accent)

  // SVG image mode keeps the catalog's markup out of the page DOM.
  return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
}
