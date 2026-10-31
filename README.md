## Item layout tool

https://layout.storagecatalog.org

### Item Fetching

Fetch the default latest release:

```sh
npm run fetch:items
```

Fetch a specific Minecraft version:

```sh
npm run fetch:items -- --game-version 1.21.8
```

The same value can also be provided with `ITEMFETCH_GAME_VERSION`.

Fetch every release from 1.21.4 on, then the older versions listed in `itemfetch/src/legacy-catalog.ts` (newest first):

```sh
npm run fetch:items:all
```

Each fetched version is written to `public/items/<version>/items.json` and added to
`public/items/versions.json`, which feeds the game version picker in the Item Library
(newest version is the default). Textures in `public/items/textures` are shared between
versions: an item whose texture differs in a version gets an extra `<id>-<hash>.png`, and
textures no catalog references any more are removed after each fetch.

Versions older than 1.21.4 have no item definitions in their assets, so their item lists come from
[minecraft-data](https://github.com/PrismarineJS/minecraft-data) (MIT) instead of decompiled code:
items are kept when a current catalog lists them (so the same items are left out as in current
versions), creative tabs are taken from the current catalogs, and icons are rendered from that
version's own assets. 1.12.2 items use their 1.13 (flattened) ids and 1.13.2 art. Fetch 1.21.4 or
newer before fetching an older version.
