// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestCompatibleWasmPack } from '../../.github/scripts/resolve-wasm-pack.mjs';

const { parse } = createRequire(resolve('packages/oxiquill/package.json'))('yaml');
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const canary = parse(readFileSync('.github/workflows/rust-canary.yml', 'utf8'));

describe('Rust compatibility CI', () => {
  it('requires the deterministic minimum job and overrides the repository toolchain', () => {
    const minimum = ci.jobs['rust-minimum'];
    expect(minimum.env).toEqual({ RUST_TOOLCHAIN: '1.85.0', RUSTUP_TOOLCHAIN: '1.85.0' });
    expect(minimum.if).toBeUndefined();
    expect(ci.jobs['ci-ok'].needs).toContain('rust-minimum');
    expect(ci.env.RUST_TOOLCHAIN).toBe('1.99.0');
    expect(minimum.steps.some((step) => step.with?.tool === 'wasm-pack@0.15.0')).toBe(true);
  });

  it('runs the same runtime and packed consumer checks in both jobs', () => {
    for (const job of [ci.jobs['rust-minimum'], canary.jobs['latest-stable']]) {
      for (const command of ['pnpm test:wasm', 'pnpm test:consumer:npm', 'pnpm test:consumer:pnpm'])
        expect(job.steps.some((step) => step.run === command)).toBe(true);
      expect(job.steps.some((step) => step.run?.includes('install-ghc-wasm.sh'))).toBe(true);
    }
    expect(canary.env.RUSTUP_TOOLCHAIN).toBe('stable');
    expect(canary.on.schedule).toEqual([{ cron: '0 3 * * 1' }]);
    expect(canary.on).toHaveProperty('workflow_dispatch');
    expect(canary.on).toHaveProperty('pull_request');
    expect(ci.jobs['ci-ok'].needs).not.toContain('latest-stable');
  });

  it('resolves the highest stable compatible upstream release numerically', () => {
    const releases = ['v0.15.1', 'v0.15.10', 'v0.16.0', 'v0.14.9', 'v0.15.100-beta.1', 'invalid', '0.15.2'].map(
      (tag_name) => ({ tag_name })
    );
    expect(
      latestCompatibleWasmPack([
        ...releases,
        { tag_name: 'v0.15.99', draft: true },
        { tag_name: 'v0.15.98', prerelease: true }
      ])
    ).toBe('0.15.10');
    expect(() => latestCompatibleWasmPack([{ tag_name: 'v0.14.0' }])).toThrow('No stable wasm-pack release');
  });
});
