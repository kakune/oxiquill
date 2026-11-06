import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve from Astro so config loading, the CLI probe, and Astro use the same Vite.
export function resolveAstroVite(importer = import.meta.url) {
  const require = createRequire(importer);
  const astroRequire = createRequire(require.resolve('astro/package.json'));
  return astroRequire.resolve('vite');
}

export const { loadConfigFromFile, mergeAlias } = await import(
  /* @vite-ignore */ pathToFileURL(resolveAstroVite()).href
);
