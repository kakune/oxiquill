// @vitest-environment node

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import {
  createRuntimeOwnedOutputs,
  createRuntimePlan,
  validateRuntimeOwnership
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';

const desired = {
  manifestFingerprint: 'manifest',
  rust: { buildFingerprint: 'rust-build', cellCount: 0, sourceFingerprint: 'rust-source' },
  python: { assetFingerprint: 'python-assets', cellCount: 0 },
  haskell: { buildFingerprint: 'haskell-build', cellCount: 0, sourceFingerprint: 'haskell-source' }
};
const emptyOutputs = {
  generated: false,
  rustSource: false,
  rustPublic: false,
  pythonPublic: false,
  haskellSource: false,
  haskellPublic: false
};

function plan(options = {}) {
  return createRuntimePlan({
    desired,
    mode: 'dev',
    outputComplete: emptyOutputs,
    outputPresent: emptyOutputs,
    ...options
  });
}

describe('runtime generation plan', () => {
  it('keeps every language absent for a new zero-cell project', () => {
    expect(plan()).toMatchObject({
      generated: 'write',
      languages: {
        rust: { public: 'keep', source: 'keep' },
        python: { public: 'keep' },
        haskell: { public: 'keep', source: 'keep' }
      }
    });
  });

  it.each([
    ['rust', { rust: { ...desired.rust, cellCount: 1 } }, { public: 'build', source: 'write' }],
    ['python', { python: { ...desired.python, cellCount: 1 } }, { public: 'copy' }],
    ['haskell', { haskell: { ...desired.haskell, cellCount: 1 } }, { public: 'build', source: 'write' }]
  ])('requests only the %s runtime for a one-language manifest', (language, override, expected) => {
    const selected = plan({ desired: { ...desired, ...override } });
    expect(selected.languages[language]).toEqual(expected);
    expect(
      Object.entries(selected.languages)
        .filter(([candidate]) => candidate !== language)
        .flatMap(([, actions]) => Object.values(actions))
    ).toEqual(expect.arrayContaining(['keep']));
  });

  it('removes stale owned output when the last cell disappears', () => {
    const state = {
      schemaVersion: 1,
      manifestFingerprint: 'old',
      languages: {
        rust: {
          buildFingerprint: 'old-build',
          mode: 'dev',
          publicFiles: ['doc_rust_cells.js'],
          sourceFingerprint: 'old-source',
          status: 'ready'
        }
      }
    };
    const selected = plan({
      outputPresent: { ...emptyOutputs, rustPublic: true, rustSource: true },
      state
    });

    expect(selected.languages.rust).toEqual({ public: 'remove', source: 'remove' });
  });

  it('performs no work for complete unchanged outputs and upgrades dev output for a production build', () => {
    const rustDesired = { ...desired, rust: { ...desired.rust, cellCount: 1 } };
    const state = {
      schemaVersion: 1,
      manifestFingerprint: 'manifest',
      languages: {
        rust: {
          buildFingerprint: 'rust-build',
          mode: 'dev',
          publicFiles: ['doc_rust_cells.js'],
          sourceFingerprint: 'rust-source',
          status: 'ready'
        }
      }
    };
    const complete = { ...emptyOutputs, generated: true, rustPublic: true, rustSource: true };

    expect(plan({ desired: rustDesired, outputComplete: complete, outputPresent: complete, state })).toMatchObject({
      generated: 'keep',
      hasChanges: false
    });
    expect(
      plan({ desired: rustDesired, mode: 'build', outputComplete: complete, outputPresent: complete, state }).languages
        .rust.public
    ).toBe('build');
  });
});

describe('runtime ownership manifest', () => {
  it('owns only exact configured language descendants and excludes licenses', () => {
    const paths = createOxiquillPaths({ workspaceRoot: path.resolve('/repo') });
    const ownedOutputs = createRuntimeOwnedOutputs(paths);
    const manifest = {
      schemaVersion: 1,
      manifestFingerprint: 'manifest',
      languages: {},
      ownedOutputs
    };

    expect(() => validateRuntimeOwnership(manifest, paths)).not.toThrow();
    expect(ownedOutputs.map(({ path: ownedPath }) => ownedPath)).not.toContain('licenses');
  });

  it.each(['../outside', '/absolute', ''])('rejects unsafe cleanup path %j', (unsafePath) => {
    const paths = createOxiquillPaths({ workspaceRoot: path.resolve('/repo') });
    const manifest = {
      schemaVersion: 1,
      manifestFingerprint: 'manifest',
      languages: {},
      ownedOutputs: [{ language: 'rust', root: 'cache', path: unsafePath }]
    };

    expect(() => validateRuntimeOwnership(manifest, paths)).toThrow(/owned output|unexpected/u);
  });
});
