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

Fetch every supported release (1.21.4 and newer), newest first:

```sh
npm run fetch:items:all
```

Each fetched version is written to `public/items/<version>/items.json` and added to
`public/items/versions.json`, which feeds the game version picker in the Item Library
(newest version is the default). Textures in `public/items/textures` are shared between
versions: an item whose texture differs in a version gets an extra `<id>-<hash>.png`, and
textures no catalog references any more are removed after each fetch.
