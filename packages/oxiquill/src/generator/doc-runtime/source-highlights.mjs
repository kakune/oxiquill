import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceThemes } from './constants.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';

let installedShikiVersion;

// The installed highlighter is immutable during a process.
function shikiVersion() {
  installedShikiVersion ??= (async () => {
    let directory = path.dirname(fileURLToPath(import.meta.resolve('shiki')));
    for (;;) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name === 'shiki') return metadata.version;
      } catch {
        /* Keep walking towards the package root. */
      }
      const parent = path.dirname(directory);
      if (parent === directory) return 'unknown';
      directory = parent;
    }
  })();
  return installedShikiVersion;
}

export async function sourceHighlightFingerprint({ generatorIdentity, version = shikiVersion }) {
  return hashText(stableFingerprint({ shiki: await version(), themes: sourceThemes, generatorIdentity }));
}

// Reuses highlighted sources of the previous generation for unchanged cells, so
// one-shot runs on a large book only highlight what was edited.
export function reusePreviousHighlights({ highlighter, previousManifest, reusable }) {
  const key = (language, source) => stableFingerprint([language, source]);
  const previous = new Map(
    reusable
      ? [...(previousManifest?.cells ?? []), ...(previousManifest?.definitions ?? [])]
          .filter((entry) => typeof entry?.sourceHtml === 'string' && typeof entry.source === 'string')
          .map((entry) => [key(entry.language, entry.source), entry.sourceHtml])
      : []
  );
  if (!previous.size) return highlighter;
  return {
    codeToHtml: async (source, options = {}) =>
      previous.get(key(options.lang, source)) ?? highlighter.codeToHtml(source, options)
  };
}
