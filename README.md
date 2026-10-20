# PepeMaps
<img width="2243" height="1173" alt="К3арта" src="https://github.com/user-attachments/assets/485d6b09-bbc0-42fa-a87d-b6a16cf8d8b9" />

An interactive Minecraft world map viewer with raster tiles, markers, and share previews.

This repository is a standalone extraction of PepeMaps. It includes the original map tiles currently used by the viewer, not synthetic demo maps. It is prepared for private review; public release and asset permissions are still pending.

## Run locally

Requires Node.js 20 or newer.

```sh
npm ci
npm run dev
```

Open the address printed by Vite. `npm test` runs the data and share-preview checks; `npm run build` creates the static site in `dist/`.

## Project layout

- `src/pepe-maps-site.jsx`: 2D map, layer selection, markers, controls, and share links.
- `public/maps/catalog.json`: available worlds and dimensions.
- `public/maps/<world>/manifest.json`: raster tile bounds and file references.
- `api/share.js` and `lib/share-preview.js`: share-page metadata and preview images on Vercel.
- `scripts/`: manifest and overview generators.

Raster tile URLs are taken from manifests. Keep the coordinate system and tile size consistent when replacing a map.

## Map data and generation

The committed map assets reproduce the current PepeMaps data. The Minecraft world save is not included. See [assets and attribution](ASSETS.md) before reusing or publicly distributing any map image.

Regenerate an overview from the existing manifests with `npm run maps:overview`. To create a new manifest, pass explicit paths:

```sh
npm run maps:manifest -- --tiles-dir public/maps/<world>/tiles/overworld --out public/maps/<world>/manifest.json
```

## Deployment

The static viewer builds with Vite. `vercel.json` configures the optional `/s/...` share pages and `/api/share-image` preview endpoint. For preview links on another host, set the variables shown in `.env.example`. Do not commit real secrets or a private world save.

## From me

Честно, работая за PepeMaps я явно получил много опыта в работе с дизайном, и разработкой сайтов, было очень много проблем которых я в итоге решил, но почему я публикую его? Потому что считаю что я устал заниматься им. И не вижу смысла держать его закрытым. Если вы хотите что-то делать то делайте! Я не против, на самом деле это было бы классно, я не получил с этого проекта ни гроша, что кстати и было одной из причин этого.

## License

The PepeMaps application source code is offered under [Apache License 2.0](LICENSE). Copies and modified distributions must retain the license and relevant attribution from [NOTICE](NOTICE). This does not automatically license the map imagery, Minecraft worlds, player builds, server branding, or third-party content. See [ASSETS.md](ASSETS.md). Public release has not yet been performed.
