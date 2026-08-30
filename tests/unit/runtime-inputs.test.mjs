import { describe, expect, it, vi } from 'vitest';
import {
  normalizeRepository,
  normalizeRuntimeInputs
} from '../../packages/oxiquill/src/generator/doc-runtime/runtime-inputs.mjs';
import {
  preflightHaskellToolchain,
  preflightRequiredToolchains,
  preflightRustToolchain
} from '../../packages/oxiquill/src/generator/doc-runtime/toolchain-preflight.mjs';

const runtimeData = {
  schemaVersion: 1,
  rust: {
    cargoVersion: '1.95.0',
    dependencies: {
      console_error_panic_hook: '0.1.7',
      serde: '1.0.228',
      serde_json: '1.0.150',
      'wasm-bindgen': '0.2.122',
      'wasm-bindgen-test': '0.3.72'
    },
    edition: '2024',
    rustVersion: '1.95',
    rustcVersion: '1.95.0',
    target: 'wasm32-unknown-unknown',
    wasmPackVersion: '0.15.0'
  },
  haskell: {
    compiler: 'wasm32-wasi-ghc',
    supportedVersionPrefix: '9.14.'
  }
};
const lock = `version = 4

[[package]]
name = "console_error_panic_hook"
version = "0.1.7"

[[package]]
name = "doc-rust-cells"
version = "0.2.0"

[[package]]
name = "serde"
version = "1.0.228"

[[package]]
name = "serde_json"
version = "1.0.150"

[[package]]
name = "wasm-bindgen"
version = "0.2.122"

[[package]]
name = "wasm-bindgen-test"
version = "0.3.72"
`;

describe('runtime inputs', () => {
  it('normalizes installed package metadata and validates pinned lock inputs', () => {
    const inputs = normalizeRuntimeInputs({
      packageJson: {
        repository: { directory: 'packages/oxiquill', url: 'git+https://example.com/oxiquill.git' },
        version: '0.2.0'
      },
      runtimeData,
      rustLock: lock
    });

    expect(inputs.package).toEqual({ repository: 'https://example.com/oxiquill', version: '0.2.0' });
    expect(Object.keys(inputs.rust.dependencies)).toEqual([
      'console_error_panic_hook',
      'serde',
      'serde_json',
      'wasm-bindgen',
      'wasm-bindgen-test'
    ]);
    expect(inputs.rustLockSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(normalizeRepository('https://example.com/repository.git')).toBe('https://example.com/repository');
  });

  it('rejects missing, inconsistent, or unsafe runtime metadata', () => {
    expect(() =>
      normalizeRuntimeInputs({
        packageJson: { repository: 'https://example.com/oxiquill', version: '9.9.9' },
        runtimeData,
        rustLock: lock
      })
    ).toThrow('expected 9.9.9');
    expect(() =>
      normalizeRuntimeInputs({
        packageJson: { repository: 'https://example.com/oxiquill', version: '0.2.0' },
        runtimeData: { ...runtimeData, schemaVersion: 2 },
        rustLock: lock
      })
    ).toThrow('schemaVersion 1');
    expect(() => normalizeRepository('git@example.com:repository.git')).toThrow('repository URL is invalid');
  });
});

describe('toolchain preflight', () => {
  it('checks only toolchains needed by the manifest and records exact versions', async () => {
    const runCommand = vi.fn(async (command, args) => {
      const invocation = [command, ...args].join(' ');
      return {
        'cargo --version': 'cargo 1.95.0 (fixture)',
        'rustc --print target-libdir --target wasm32-unknown-unknown': '/toolchain/lib',
        'rustc --version': 'rustc 1.95.0 (fixture)',
        'wasm-pack --version': 'wasm-pack 0.15.0'
      }[invocation];
    });
    const fileSystem = {
      readdir: async () => ['libcore-fixture.rlib']
    };
    const runtimeInputs = normalizeRuntimeInputs({
      packageJson: { repository: 'https://example.com/oxiquill', version: '0.2.0' },
      runtimeData,
      rustLock: lock
    });

    await expect(
      preflightRequiredToolchains({
        fileSystem,
        haskellCellCount: 0,
        mode: 'build',
        runCommand,
        runtimeInputs,
        rustCellCount: 1
      })
    ).resolves.toEqual({
      rust: {
        cargo: 'cargo 1.95.0 (fixture)',
        rustc: 'rustc 1.95.0 (fixture)',
        target: 'wasm32-unknown-unknown',
        'wasm-pack': 'wasm-pack 0.15.0'
      }
    });
    expect(runCommand).not.toHaveBeenCalledWith('wasm32-wasi-ghc', expect.anything());
    await expect(
      preflightRequiredToolchains({
        haskellCellCount: 1,
        mode: undefined,
        runCommand,
        runtimeInputs,
        rustCellCount: 1
      })
    ).resolves.toEqual({});
  });

  it('reports commands, expected versions, actual output, and setup guidance', async () => {
    await expect(
      preflightRustToolchain({
        fileSystem: { readdir: async () => [] },
        runCommand: async () => 'rustc 1.94.0',
        runtimeInputs: runtimeData.rust
      })
    ).rejects.toThrow('"rustc --version" expected rustc 1.95.0; received rustc 1.94.0');

    await expect(
      preflightHaskellToolchain({
        environment: {},
        platform: 'win32',
        runCommand: vi.fn(),
        runtimeInputs: runtimeData.haskell
      })
    ).rejects.toThrow('native Windows Haskell/WASI generation is unsupported');

    await expect(
      preflightHaskellToolchain({
        environment: { OXIQUILL_HASKELL_GHC: '/opt/wasm-ghc' },
        platform: 'linux',
        runCommand: async () => '9.14.1.20260330',
        runtimeInputs: runtimeData.haskell
      })
    ).resolves.toEqual({ command: '/opt/wasm-ghc', version: '9.14.1.20260330' });
  });
});
