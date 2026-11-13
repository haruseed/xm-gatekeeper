# Challenge assets

The ten source SVGs in `source/` are original geometric demo illustrations,
released under this repository's MIT licence. They are deliberately recognisable
and are intended for development and integration testing, not strong bot protection.
No Ingress game artwork, production challenge images or bot logos are included.

Run `bun run assets:build` to generate `items/*.png` and `manifest.json`.
Run `bun run boards:build -- assets/board-bank 40` to build a small development bank;
use a larger bank (for example 300) when evaluating deployment.
The builder refuses to overwrite an existing bank. Build a new directory and
replace it while the bot is stopped. Rebuild whenever asset hashes or labels change.

For an Ingress-specific deployment, replace the demo asset pipeline with artwork
you have permission to use. Populate the `ItemAsset` fields defined in
`packages/assets/src/index.ts`, record the source and redistribution permission,
review each image, and set `approval: "approved"` only after review. Supply at least
eight distinct assets with complete labels and matching SHA-256 hashes. Keep source
licences and notices with the deployed assets. A wiki page or download link alone
does not grant redistribution rights. Built-in function questions are selected
only for recognised Ingress item IDs in `FUNCTION_ITEMS`; other IDs use labels.
