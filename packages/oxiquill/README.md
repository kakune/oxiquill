# Oxiquill

Oxiquill is an Astro/Starlight framework for static, prose-first technical documentation with executable Rust/Wasm, Python/Pyodide, and Haskell/WASI cells, plus math, diagrams, media, and rich output.

Oxiquill requires Node.js 24 or newer and supports consumer installation with npm and pnpm on Linux, macOS, and Windows.

## Create or Install

Create the versioned static starter without a global install:

```sh
pnpm dlx oxiquill init my-docs
cd my-docs
pnpm install
pnpm check
pnpm build
pnpm preview
```

`init` accepts only a nonexistent or empty target and never overwrites files, installs dependencies, or initializes Git.

For an existing project, use either package manager:

```sh
pnpm add oxiquill@0.3.0 astro@7.2.9 @astrojs/starlight@0.41.9
```

```sh
npm install oxiquill@0.2.0 astro@7.2.9 @astrojs/starlight@0.41.9
```

Route documentation scripts through the CLI:

```json
{
  "scripts": {
    "dev": "oxiquill dev",
    "build": "oxiquill build",
    "check": "oxiquill check",
    "preview": "oxiquill preview",
    "clean": "oxiquill clean"
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

Write pages under `content/docs`. Generated internals go under `.oxiquill`, browser assets go under `public/oxiquill`, and the static build normally goes under `dist`. Verified Pyodide downloads are cached under `.cache/oxiquill/downloads/v1`; `oxiquill clean` preserves that cache so later online or offline generation can reconstruct the public runtime.

Static projects need only Node.js and a package manager. Rust cells additionally need the pinned Rust toolchain and `wasm-pack`; Haskell generation needs `wasm32-wasi-ghc` on Linux or macOS. Generated sites run in current Chromium, Firefox, and WebKit.

## Documentation and Support

- [Getting started](https://kakune.github.io/oxiquill/guides/getting-started/)
- [Project configuration](https://kakune.github.io/oxiquill/guides/project-configuration/)
- [Package API](https://kakune.github.io/oxiquill/reference/package-api/)
- [CLI reference](https://kakune.github.io/oxiquill/reference/cli/)
- [Interactive cells](https://kakune.github.io/oxiquill/features/interactive-cells/)
- [Rich output](https://kakune.github.io/oxiquill/features/rich-output/)
- [Compatibility and trust model](https://kakune.github.io/oxiquill/guides/support-and-security/)
- [Troubleshooting](https://kakune.github.io/oxiquill/guides/troubleshooting/)
- [Security policy](https://github.com/kakune/oxiquill/security/policy)

Author-provided cell code and selected runtime packages execute in browser workers. Review executable content and dependencies before publication. Sandboxed HTML has no script or same-origin permission, but it is not an HTML sanitizer.

Production builds emit `dist/oxiquill/bundle-report.json` and fail if any generated client or worker JavaScript chunk exceeds 650 KiB uncompressed. Copied runtime assets such as Pyodide remain outside this chunk budget and are loaded only by the relevant runtime.

## License notices

Oxiquill is available under your choice of the MIT License or the Apache License, Version 2.0. Each generated site automatically receives `oxiquill/licenses/LICENSE-MIT`, `LICENSE-APACHE`, and `THIRD_PARTY_LICENSES.txt` as non-visible static assets. No visible attribution or “Powered by Oxiquill” notice is required.

See the [full documentation](https://kakune.github.io/oxiquill/) and [source repository](https://github.com/kakune/oxiquill) for authoring, runtime, validation, and contribution guidance.
