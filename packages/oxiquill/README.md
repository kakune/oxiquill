# Oxiquill

Oxiquill is an Astro/Starlight framework for static, prose-first technical documentation with executable Rust/Wasm, Python/Pyodide, and Haskell/WASI cells, plus math, diagrams, media, and rich output.

## Install

Oxiquill requires Node.js 24 or newer. Rust cells also require the repository's pinned Rust toolchain and `wasm-pack`; Haskell cells require `wasm32-wasi-ghc`.

```sh
pnpm add oxiquill@0.2.0 astro@7.2.9 @astrojs/starlight@0.41.9
```

Route the documentation scripts through the CLI:

```json
{
  "scripts": {
    "dev": "oxiquill dev",
    "build": "oxiquill build",
    "check": "oxiquill check"
  }
}
```

Create `astro.config.mjs`:

```js
import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  framework: { starlight },
  title: 'My Docs',
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
```

Create `content.config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { createOxiquillCollections } from 'oxiquill/content';

export const collections = createOxiquillCollections({ defineCollection, docsLoader, docsSchema });
```

Write pages under `content/docs`. Generated internals go under `.oxiquill`, and browser assets go under `public/oxiquill`.

Production builds emit `dist/oxiquill/bundle-report.json` and fail if any generated client or worker JavaScript chunk exceeds 650 KiB uncompressed. Copied runtime assets such as Pyodide remain outside this chunk budget and are loaded only by the relevant runtime.

## License notices

Oxiquill is available under your choice of the MIT License or the Apache License, Version 2.0. Each generated site automatically receives `oxiquill/licenses/LICENSE-MIT`, `LICENSE-APACHE`, and `THIRD_PARTY_LICENSES.txt` as non-visible static assets. No visible attribution or “Powered by Oxiquill” notice is required.

See the [full documentation](https://kakune.github.io/oxiquill/) and [source repository](https://github.com/kakune/oxiquill) for authoring, runtime, validation, and contribution guidance.
