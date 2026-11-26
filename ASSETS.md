# Map assets and attribution

The `public/maps/` directory contains original PepeMaps map tiles, markers, and overviews. `public/pepe-brand-icon.svg` is a brand asset. The viewer also depicts Minecraft worlds and builds by other people.

These assets are included to reproduce the existing site. Their inclusion here does **not** mean that the Apache-2.0 license in `LICENSE` covers them. Access to an image on a public website is not a license to redistribute or modify it.

The Season 11 trade map uses a 64x64 color-matched correction at world coordinates X=-64, Z=-64. The patch is stored in `map-corrections/trade-season11/` and baked into the `-fix1.png` tile used by the manifest; the original tile is retained.

Before reusing or redistributing the map tiles, logo, names, or player-created builds, determine their rights and intended terms. Add explicit asset permissions and credits where applicable. The software license and `NOTICE` cover the application source code only.

The Onest font files in `public/fonts/` are distributed under the SIL Open Font License 1.1; see `public/fonts/Onest-OFL.txt`.

The Minecraft player heads in `public/contributors/` are cached from mc-heads.net for the named contributors. Their inclusion does not imply that the application source-code license covers player skins.

The contributor crown uses the [Discord web client's CrownIcon](https://discord.com/assets/web.1732a939a32a5e17.js). It is a Discord asset, not part of the application source-code license.
