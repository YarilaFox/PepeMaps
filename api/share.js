import { loadShareContext, renderShareHtml, renderShareImage } from "../lib/share-preview.js"

export async function handleShareImage(req, res) {
  if (req.method !== "GET") return res.status(405).end()

  try {
    const context = await loadShareContext(req.query, req)
    if (!context) return res.status(404).end()

    const image = await renderShareImage(context)
    res.setHeader("Content-Type", "image/jpeg")
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=86400")
    return res.status(200).send(image)
  } catch (error) {
    console.error("Share image failed:", error)
    return res.status(502).end()
  }
}

export default async function handler(req, res, routeParams = req.query) {
  if (req.query?.mode === "image") return handleShareImage(req, res)
  if (req.method !== "GET") return res.status(405).end()

  try {
    const context = await loadShareContext(routeParams, req)
    if (!context) return res.status(404).send("Место на карте не найдено")

    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400")
    return res.status(200).send(renderShareHtml(req, context))
  } catch (error) {
    console.error("Share page failed:", error)
    return res.status(502).send("Не удалось создать ссылку на карту")
  }
}
