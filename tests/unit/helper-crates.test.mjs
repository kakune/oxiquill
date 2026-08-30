import { describe, expect, it } from 'vitest';
import {
  helperCratesFromManifests,
  packageNameFromCargoToml
} from '../../packages/oxiquill/src/generator/doc-runtime-core.mjs';

const manifestPath = '/repo/crates/helper/Cargo.toml';

describe('helper crate manifests', () => {
  it.each([
    ['standard table', '[package]\nname = "standard-crate"\n', 'standard-crate'],
    ['comments and whitespace', '  # package metadata\n[ package ]\n name = "spaced_crate" # name\n', 'spaced_crate'],
    ['literal string', "[package]\nname = 'literal-crate'\n", 'literal-crate'],
    ['dotted key', "package.name = 'dotted-crate'\n", 'dotted-crate'],
    ['Unicode alphanumeric characters', '[package]\nname = "補助-crate٢"\n', '補助-crate٢']
  ])('parses a Cargo manifest using %s syntax', (_label, source, expected) => {
    expect(packageNameFromCargoToml(source, manifestPath)).toBe(expected);
  });

  it.each([
    ['malformed TOML', '[package\nname = "broken"\n', 'contains malformed TOML'],
    ['missing package table', '[dependencies]\nserde = "1"\n', 'is missing a [package] table'],
    ['missing name', '[package]\nversion = "1.0.0"\n', 'is missing package.name'],
    ['non-string name', '[package]\nname = 42\n', 'has a non-string package.name'],
    ['empty name', '[package]\nname = ""\n', 'has invalid package.name ""'],
    ['invalid name', '[package]\nname = "invalid name"\n', 'has invalid package.name "invalid name"']
  ])('reports a path-qualified diagnostic for %s', (_label, source, message) => {
    expect(() => packageNameFromCargoToml(source, manifestPath)).toThrow(
      `Helper crate manifest ${manifestPath} ${message}`
    );
  });

  it('sorts crates and reports both paths for duplicate effective names', () => {
    const manifests = [
      { content: 'package.name = "same"\n', manifestPath: '/repo/crates/z/Cargo.toml' },
      { content: '[package]\nname = "same"\n', manifestPath: '/repo/crates/a/Cargo.toml' }
    ];

    expect(() => helperCratesFromManifests(manifests, { rustCellsDir: '/repo/.oxiquill/rust-cells' })).toThrow(
      'Helper crate manifests /repo/crates/z/Cargo.toml and /repo/crates/a/Cargo.toml use duplicate package name "same".'
    );

    const crates = helperCratesFromManifests(
      [
        { content: '[package]\nname = "z-crate"\n', manifestPath: '/repo/crates/z/Cargo.toml' },
        { content: 'package.name = "a-crate"\n', manifestPath: '/repo/crates/a/Cargo.toml' }
      ],
      { rustCellsDir: '/repo/.oxiquill/rust-cells' }
    );
    expect(Array.from(crates.keys())).toEqual(['a-crate', 'z-crate']);
  });
});
