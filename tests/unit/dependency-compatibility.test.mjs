// @vitest-environment node
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveAstroVite } from '../../packages/oxiquill/src/config/astro-vite.mjs';
import { compatibilityManifest, compatibilityWorkspace, minimumDependencies } from '../package/compatibility.mjs';

const published = {
  peerDependencies: { astro: '^7.3.8', '@astrojs/starlight': '~0.42.6' },
  dependencies: { preact: '^10.29.8', katex: '0.19.0', mermaid: '~11.17.2' }
};
const starter = { dependencies: { astro: '7.3.8', '@astrojs/starlight': '0.42.6', oxiquill: 'file:package.tgz' } };

describe('dependency compatibility', () => {
  it('resolves Vite from Astro rather than an unrelated workspace copy', () => {
    const importer = new URL('../../packages/oxiquill/package.json', import.meta.url);
    const require = createRequire(importer);
    const astroRequire = createRequire(require.resolve('astro/package.json'));
    expect(realpathSync(resolveAstroVite(importer))).toBe(realpathSync(astroRequire.resolve('vite')));
  });

  it('keeps starter pins and applies supported peers to floating consumers without mutation', () => {
    expect(compatibilityManifest(starter, published, 'starter', 'npm')).toBe(starter);
    const floating = compatibilityManifest(starter, published, 'highest', 'npm');
    expect(floating.dependencies).toEqual({ ...starter.dependencies, ...published.peerDependencies });
    expect(floating.overrides).toBeUndefined();
    expect(starter.dependencies.astro).toBe('7.3.8');
    expect(() => compatibilityManifest(starter, published, 'invalid', 'npm')).toThrow('Unknown compatibility profile');
  });

  it('constrains actual packed dependencies to minima for each package manager', () => {
    const minima = { preact: '10.29.8', katex: '0.19.0', mermaid: '11.17.2' };
    expect(minimumDependencies(published.dependencies)).toEqual(minima);
    expect(compatibilityManifest(starter, published, 'lowest', 'npm').overrides).toEqual({ oxiquill: minima });
    expect(compatibilityWorkspace(published, 'lowest')).toMatchObject({
      resolutionMode: 'lowest-direct',
      overrides: { 'oxiquill>preact': '10.29.8' }
    });
    expect(compatibilityWorkspace(published, 'highest')).toEqual({ minimumReleaseAge: 0, resolutionMode: 'highest' });
    expect(() => minimumDependencies({ example: 'invalid' })).toThrow();
  });
});
