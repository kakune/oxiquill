import { describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  parseToolVersion,
  parseVersion
} from '../../packages/oxiquill/src/generator/doc-runtime/toolchain-versions.mjs';
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
    dependencies: {
      console_error_panic_hook: '0.1.7',
      serde: '1.0.228',
      serde_json: '1.0.150',
      'wasm-bindgen': '0.2.122'
    },
    edition: '2024',
    minimumVersion: '1.85.0',
    testedVersion: '1.99.0',
    target: 'wasm32-unknown-unknown',
    wasmPackMinimumVersion: '0.15.0',
    wasmPackMaximumVersionExclusive: '0.16.0'
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
      'wasm-bindgen'
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
        environment: {},
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
        'wasm-pack': 'wasm-pack 0.15.0',
        wasmOpt: { identity: 'managed-by-wasm-pack' }
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
        runCommand: async () => 'rustc 1.84.1',
        runtimeInputs: runtimeData.rust
      })
    ).rejects.toThrow('"rustc --version" expected rustc >=1.85.0 (tested 1.99.0); received "rustc 1.84.1"');

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

function rustPreflight(versions = {}, overrides = {}) {
  return preflightRustToolchain({
    environment: {},
    fileSystem: { readdir: async () => [{ name: 'libcore-fixture.rlib' }] },
    runCommand: async (command, args) =>
      args[0] === '--print'
        ? '/toolchain/lib'
        : `${command} ${versions[command] ?? (command === 'wasm-pack' ? '0.15.0' : '1.99.0')}`,
    runtimeInputs: runtimeData.rust,
    ...overrides
  });
}

describe('consumer toolchain versions', () => {
  it.each(['1.85.0', '1.99.0', '1.99.1', '1.100.0', '1.85.0-beta.1', '1.100.0-nightly'])(
    'accepts Rust and Cargo %s',
    async (version) => {
      await expect(rustPreflight({ rustc: version, cargo: version })).resolves.toMatchObject({
        rustc: `rustc ${version}`,
        cargo: `cargo ${version}`
      });
    }
  );

  it.each(['rustc', 'cargo'])('rejects old %s with detected, minimum, tested versions and guidance', async (tool) => {
    const result = rustPreflight({ [tool]: '1.84.9' });
    await expect(result).rejects.toThrow(`${tool} >=1.85.0 (tested 1.99.0); received "${tool} 1.84.9"`);
    await expect(result).rejects.toThrow('rustup target add wasm32-unknown-unknown');
    await expect(result).rejects.not.toThrow('--toolchain');
  });

  it.each(['0.15.0', '0.15.1', '0.15.99'])('accepts wasm-pack %s', async (version) => {
    await expect(rustPreflight({ 'wasm-pack': version })).resolves.toMatchObject({
      'wasm-pack': `wasm-pack ${version}`
    });
  });

  it.each(['0.14.9', '0.16.0', '0.16.0-beta.1', '0.15.1-nightly'])('rejects wasm-pack %s', async (version) => {
    await expect(rustPreflight({ 'wasm-pack': version })).rejects.toThrow('wasm-pack >=0.15.0 <0.16.0');
  });

  it.each([
    '',
    'unexpected output',
    '\n unexpected output \n',
    'rustc 1.85',
    'rustc 1.85.0oops',
    'cargo 1.99.0',
    'rustc 1.99.0\nextra'
  ])('quotes malformed output %j', async (output) => {
    await expect(rustPreflight({}, { runCommand: async () => output })).rejects.toThrow(
      `received ${JSON.stringify(output)}`
    );
  });

  it('reports missing tools and missing target libraries', async () => {
    await expect(
      rustPreflight(
        {},
        {
          runCommand: async () => {
            throw new Error('spawn ENOENT');
          }
        }
      )
    ).rejects.toThrow('spawn ENOENT');
    await expect(rustPreflight({}, { fileSystem: { readdir: async () => [] } })).rejects.toThrow(
      'no Rust core library'
    );
    await expect(
      rustPreflight(
        {},
        {
          fileSystem: {
            readdir: async () => {
              throw new Error('missing directory');
            }
          }
        }
      )
    ).rejects.toThrow('installed target wasm32-unknown-unknown');
  });

  it('parses compiler details and compares numeric components', () => {
    expect(parseToolVersion('rustc 1.100.0 (hash date)', 'rustc')).toEqual([1, 100, 0]);
    expect(parseToolVersion('cargo 1.100.0-beta.2 (hash date)', 'cargo')).toEqual([1, 100, 0]);
    expect(compareVersions([1, 100, 0], [1, 99, 1])).toBe(1);
    expect(compareVersions([1, 85, 0], [1, 85, 0])).toBe(0);
    expect(compareVersions([0, 15, 0], [0, 15, 1])).toBe(-1);
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseVersion('01.85.0')).toBeUndefined();
    expect(parseVersion('1.99999999999999999999.0')).toBeUndefined();
  });

  it.each(['minimumVersion', 'testedVersion', 'wasmPackMinimumVersion', 'wasmPackMaximumVersionExclusive'])(
    'rejects invalid runtime policy %s',
    (field) => {
      expect(() =>
        normalizeRuntimeInputs({
          packageJson: { repository: 'https://example.com/oxiquill', version: '0.2.0' },
          runtimeData: { ...runtimeData, rust: { ...runtimeData.rust, [field]: 'invalid' } },
          rustLock: lock
        })
      ).toThrow(`major.minor.patch version for ${field}`);
    }
  );
});
