import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function writeBuildReport({ cacheDir, config, dir }) {
  const report = {
    outDir: path.resolve(fileURLToPath(dir)),
    site: config.site ?? null,
    base: config.base,
    trailingSlash: config.trailingSlash,
    build: { format: config.build.format },
    redirects: config.redirects
  };
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
