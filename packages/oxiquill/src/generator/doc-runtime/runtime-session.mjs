import { hashText, stableFingerprint } from './hashing.mjs';

const memoizedHighlighter = Symbol('oxiquill.memoized-highlighter');

// State owned by one long-lived development watcher and passed explicitly into
// each sync. It keeps per-page parse results, highlighted sources, and toolchain
// probes for unchanged inputs; entries not used by the latest sync are dropped.
export function createRuntimeSession() {
  let generation = 0;
  const pages = new Map();
  const highlights = new Map();
  const toolchains = new Map();
  const touch = (map, key, value) => {
    map.set(key, { value, generation });
    return value;
  };
  return Object.freeze({
    beginSync() {
      generation += 1;
    },
    endSync() {
      for (const map of [pages, highlights])
        for (const [key, entry] of map) if (entry.generation !== generation) map.delete(key);
    },
    // Page parsing is pure for its source text, path, and Python options.
    parsePage(parse) {
      return (source, pagePath, pythonOptions) => {
        const key = hashText(stableFingerprint([source, pythonOptions ?? {}]));
        const hit = pages.get(pagePath);
        if (hit?.value.key === key) return touch(pages, pagePath, hit.value).result;
        const { cells, diagnostics, page } = parse(source, pagePath, pythonOptions);
        return touch(pages, pagePath, { key, result: { cells, diagnostics, page } }).result;
      };
    },
    highlighter(highlighter) {
      if (!highlighter || highlighter[memoizedHighlighter]) return highlighter;
      return Object.freeze({
        [memoizedHighlighter]: true,
        async codeToHtml(source, options = {}) {
          const key = stableFingerprint([options.lang, options.themes, source]);
          const hit = highlights.get(key);
          if (hit) return touch(highlights, key, hit.value);
          return touch(highlights, key, await highlighter.codeToHtml(source, options));
        },
        dispose: () => highlighter.dispose?.()
      });
    },
    // Toolchain probes are reused while the probe inputs are unchanged; a
    // toolchain replaced behind the same PATH needs a watcher restart.
    async toolchain(key, probe) {
      if (!toolchains.has(key)) {
        const pending = probe();
        toolchains.set(key, pending);
        pending.catch(() => toolchains.delete(key));
      }
      return toolchains.get(key);
    },
    clearToolchains() {
      toolchains.clear();
    }
  });
}

export function toolchainProbeKey({ environment, toolchainFiles, flags }) {
  const names = [
    'PATH',
    'PATHEXT',
    'RUSTUP_TOOLCHAIN',
    'RUSTC',
    'CARGO',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'OXIQUILL_HASKELL_GHC'
  ];
  return hashText(
    stableFingerprint({
      environment: names.map((name) => [name, environment[name] ?? null]),
      toolchainFiles,
      flags
    })
  );
}
