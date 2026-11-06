import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copied into the isolated consumer. This observes actual build modules without
// adding test reporting to the published integration or generated site.
export function compatibilityProbe() {
  return {
    name: 'oxiquill-test-framework-identities',
    generateBundle(_options, bundle) {
      const roots = Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .flatMap((chunk) => Object.keys(chunk.modules))
        .flatMap((id) => {
          const root = /^(.*[/\\]node_modules[/\\](?:astro|preact))(?=[/\\])/u.exec(id)?.[1];
          return root ? [realpathSync(root)] : [];
        });
      const packages = [...new Set(roots)].sort().map((root) => ({
        root,
        ...JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
      }));
      for (const name of ['astro', 'preact']) {
        assert.ok(packages.filter((entry) => entry.name === name).length <= 1, `Duplicate ${name} in a build`);
      }
      appendFileSync(
        fileURLToPath(new URL('./framework-modules.jsonl', import.meta.url)),
        `${JSON.stringify(packages.map(({ name, version, root }) => ({ name, version, root })))}\n`
      );
    }
  };
}
