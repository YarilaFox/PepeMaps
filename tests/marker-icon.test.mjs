import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { getMarkerIconSource } from "../src/marker-icon.js"

test("the clipboard formatter makes a complete SVG a valid JSON marker field", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16">\n<path fill="rgba(45, 45, 45, 255)" d="M1 2h1v1H1z"/>\n</svg>'
  const result = spawnSync(process.execPath, ["scripts/format-marker-icon.mjs"], {
    input: svg,
    encoding: "utf8"
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(`{${result.stdout}}`).icon, svg)
})

test("empty and unsupported marker icon values fall back to the standard icon", () => {
  for (const value of [null, " ", "<div>Not an icon</div>", "https://example.com/icon.svg"]) {
    assert.equal(getMarkerIconSource(value, "#334455"), "")
  }
})
