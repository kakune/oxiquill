// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { parse } = createRequire(resolve('packages/oxiquill/package.json'))('yaml');
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const canary = parse(readFileSync('.github/workflows/rust-canary.yml', 'utf8'));

describe('Rust compatibility CI', () => {
  it('provides pinned Binaryen for the real optimizer-cache smoke test', () => {
    const step = ci.jobs.runtime.steps.find((entry) => entry.run === 'bash .github/scripts/install-binaryen.sh');
    expect(step?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    const installer = readFileSync('.github/scripts/install-binaryen.sh', 'utf8');
    expect(installer).toContain('gh release download version_117');
    expect(installer).toContain('sha256sum --check --strict');
    expect(installer).toContain('wasm-opt version 117 (version_117)');
  });

  it('requires the deterministic minimum job and overrides the repository toolchain', () => {
    const minimum = ci.jobs['rust-minimum'];
    expect(minimum.env).toEqual({ RUST_TOOLCHAIN: '1.85.0', RUSTUP_TOOLCHAIN: '1.85.0' });
    expect(minimum.if).toBeUndefined();
    expect(ci.jobs['ci-ok'].needs).toContain('rust-minimum');
    expect(ci.env.RUST_TOOLCHAIN).toBe('1.99.0');
  });

  it('runs the same runtime and packed consumer checks in both jobs', () => {
    for (const job of [ci.jobs['rust-minimum'], canary.jobs['latest-stable']]) {
      for (const command of ['pnpm test:wasm', 'pnpm test:consumer:npm', 'pnpm test:consumer:pnpm'])
        expect(job.steps.some((step) => step.run === command)).toBe(true);
      expect(job.steps.some((step) => step.run?.includes('install-ghc-wasm.sh'))).toBe(true);
      expect(job.steps.some((step) => step.run === 'bash .github/scripts/install-wasm-bindgen.sh')).toBe(true);
      const binaryen = job.steps.find((step) => step.run === 'bash .github/scripts/install-binaryen.sh');
      expect(binaryen?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
      for (const command of ['pnpm test:wasm', 'pnpm test:consumer:npm', 'pnpm test:consumer:pnpm'])
        expect(job.steps.find((step) => step.run === command).env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    }
    expect(canary.env.RUSTUP_TOOLCHAIN).toBe('stable');
    expect(canary.on.schedule).toEqual([{ cron: '0 3 * * 1' }]);
    expect(canary.on).toHaveProperty('workflow_dispatch');
    expect(canary.on).toHaveProperty('pull_request');
    expect(ci.jobs['ci-ok'].needs).not.toContain('latest-stable');
  });

  it('no longer installs wasm-pack in any workflow', () => {
    for (const workflow of readdirSync('.github/workflows'))
      expect(readFileSync(`.github/workflows/${workflow}`, 'utf8')).not.toMatch(/wasm-pack|WASM_PACK/u);
    expect(existsSync('.github/scripts/resolve-wasm-pack.mjs')).toBe(false);
  });
});

describe('CI release downloads', () => {
  it('retries every failed ghc-wasm download, including transfers that fail mid-stream', () => {
    const installer = readFileSync('.github/scripts/install-ghc-wasm.sh', 'utf8');
    expect(installer).toContain("printf '%s\\n' 'retry-all-errors'");
    expect(installer).toMatch(/CURL_HOME="\$curl_home" FLAVOUR=.*\.\/setup\.sh/u);
  });
});
