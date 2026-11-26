import { readFileSync } from "node:fs"

const svg = readFileSync(process.argv[2] ?? 0, "utf8").trim()
if (!/^(?:<\?xml\s[^?]*\?>\s*)?<svg(?=[\s/>])/.test(svg)) {
  process.stderr.write("Expected a complete SVG from a file or standard input.\n")
  process.exitCode = 1
} else {
  process.stdout.write(`"icon": ${JSON.stringify(svg)}\n`)
}
