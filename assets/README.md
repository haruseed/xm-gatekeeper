# Challenge assets

This directory holds the artwork used to build picture challenges, and the
generated files the bot reads at runtime.

> [!IMPORTANT]
> The bundled artwork consists of simple geometric shapes intended for development
> and integration testing. They are easy to recognise and **do not provide strong
> bot protection**. Replace them before production use.

## Contents

| Path            | Tracked | Description                                               |
| --------------- | :-----: | --------------------------------------------------------- |
| `source/*.svg`  | Yes     | Ten original geometric demo illustrations.                |
| `source/items.json` | Yes | Item IDs and their English, Traditional and Simplified Chinese labels. |
| `items/*.png`   | No      | 256 × 256 PNGs rasterised from `source/`.                 |
| `manifest.json` | No      | Asset manifest with labels, provenance and SHA-256 hashes. |
| `board-bank/`   | No      | Pre-rendered challenge boards served at runtime.          |

Generated files are excluded from version control and must be built locally.

## Building

```sh
bun run assets:build                          # write items/*.png and manifest.json
bun run boards:build -- assets/board-bank 40  # build a development board bank
bun run assets:validate                       # check assets, hashes and translations
```

A bank of 40 boards is enough for development. For production evaluation, build a
larger bank, for example 300 boards (maximum 5000).

### Replacing a board bank

The board builder never overwrites an existing directory. To replace a bank:

1. Build into a new directory, e.g. `bun run boards:build -- assets/board-bank-v2 300`.
2. Stop the bot.
3. Replace the active bank with the new one.
4. Start the bot.

Rebuild the bank whenever asset images, hashes or labels change. The bot detects
a bank that no longer matches the current manifest.

## Using custom artwork

For an Ingress-specific deployment, replace the demo pipeline with artwork you are
licensed to use.

### Requirements

- At least **eight** distinct approved assets.
- A complete label for every supported locale.
- A SHA-256 hash in the manifest that matches each image file.
- A provenance record for each asset, including its source, rights holder, licence
  and evidence of redistribution permission.

### Manifest fields

Each entry in `manifest.json` is an `ItemAsset`, defined in
[`packages/assets/src/index.ts`](../packages/assets/src/index.ts).

| Field                    | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `id`                     | Unique ID: lowercase letters, digits and `-`, up to 40 characters. |
| `labels`                 | Display name for each locale.                            |
| `localRelativePath`      | Image path relative to this directory.                   |
| `sha256`                 | Hex SHA-256 of the image file.                           |
| `originalSourceUrl`, `articleUrl`, `filePageUrl` | Where the artwork came from.     |
| `creator`, `rightsHolder` | Author and copyright owner.                             |
| `licenceName`, `licenceUrl`, `attributionText` | Licence terms and required attribution. |
| `permissionEvidencePath` | Path to evidence of permission to redistribute.          |
| `modifications`          | Changes made to the original artwork.                    |
| `reviewedBy`, `reviewedAt` | Who reviewed the asset, and when.                      |
| `approval`               | `pending`, `approved` or `rejected`.                     |

Only assets marked `approved` are used in challenges. Set `approval` to `approved`
only after reviewing the image and its provenance record.

### Licensing

Keep source licences and notices alongside the deployed assets. A wiki page or a
public download link does not, by itself, grant redistribution rights.

### Question types

Picture questions ask the user to identify an item by its label. Item IDs listed in
`FUNCTION_ITEMS` ([`packages/captcha/src/index.ts`](../packages/captcha/src/index.ts))
are recognised Ingress items and may instead be asked about by function. All other
IDs use label questions only.

## Licence

The demo artwork in `source/` is original work released under the repository's
[MIT Licence](../LICENSE). It contains no Ingress game artwork, production challenge
images or bot logos.
