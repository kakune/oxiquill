// @vitest-environment node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageRoot = path.join(repositoryRoot, 'packages/oxiquill');

describe('repository license contract', () => {
  it('declares the same dual-license choice in root and package metadata', async () => {
    const rootPackage = await readJson(path.join(repositoryRoot, 'package.json'));
    const publishedPackage = await readJson(path.join(packageRoot, 'package.json'));

    expect(rootPackage.license).toBe('MIT OR Apache-2.0');
    expect(publishedPackage.license).toBe('MIT OR Apache-2.0');
  });

  it('links both complete license texts from the canonical entry point', async () => {
    const canonicalLicense = await readFile(path.join(repositoryRoot, 'LICENSE'), 'utf8');
    const mitLicense = await readFile(path.join(repositoryRoot, 'LICENSE-MIT'), 'utf8');
    const apacheLicense = await readFile(path.join(repositoryRoot, 'LICENSE-APACHE'), 'utf8');

    expect(canonicalLicense).toContain('[MIT License](LICENSE-MIT)');
    expect(canonicalLicense).toContain('[Apache License, Version 2.0](LICENSE-APACHE)');
    expect(canonicalLicense).toContain('SPDX-License-Identifier: MIT OR Apache-2.0');
    expect(mitLicense).toContain('MIT License');
    expect(apacheLicense).toContain('Apache License\n                           Version 2.0');
    await expect(readFile(path.join(packageRoot, 'LICENSE-MIT'), 'utf8')).resolves.toBe(mitLicense);
    await expect(readFile(path.join(packageRoot, 'LICENSE-APACHE'), 'utf8')).resolves.toBe(apacheLicense);
  });

  it('ships both license texts and keeps public and contribution prose consistent', async () => {
    const publishedPackage = await readJson(path.join(packageRoot, 'package.json'));
    const rootReadme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const packageReadme = await readFile(path.join(packageRoot, 'README.md'), 'utf8');
    const contributing = await readFile(path.join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8');

    expect(publishedPackage.files).toEqual(expect.arrayContaining(['LICENSE-MIT', 'LICENSE-APACHE']));
    expect(rootReadme).toContain('[MIT License](./LICENSE-MIT)');
    expect(rootReadme).toContain('[Apache License, Version 2.0](./LICENSE-APACHE)');
    expect(packageReadme).toContain('your choice of the MIT License or the Apache License, Version 2.0');
    expect(contributing).toContain('licensed under both the MIT License and the Apache License, Version 2.0');
  });
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}
