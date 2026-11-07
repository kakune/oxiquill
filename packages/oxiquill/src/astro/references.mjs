import path from 'node:path';
import { collectAuthoringContent } from '../generator/doc-runtime/cell-collection.mjs';
import { pathFromUrl } from '../config/paths.mjs';
import { hashText, stableFingerprint } from '../generator/doc-runtime/hashing.mjs';
import { createReferenceRegistry } from '../lib/doc-runtime/references.mjs';

// Per-integration state; parsing and registry construction remain independent of Vite.
export function createReferences({ paths, pythonOptions, generation }) {
  let config = {};
  let pending;
  const consumers = new Set();
  const root = pathFromUrl(paths.workspaceRoot);

  async function current() {
    if (!pending) {
      pending = (async () => {
        const snapshot = generation?.current()?.snapshot;
        const { pages } = snapshot ?? (await collectAuthoringContent({ paths, pythonOptions }));
        const registry = createReferenceRegistry(pages, config);
        return {
          pages,
          registry,
          fingerprint: hashText(
            stableFingerprint(
              [...registry.entries()].map(([key, target]) => [
                key,
                target.pagePath,
                target.route,
                target.kind,
                target.slug,
                target.cellId
              ])
            )
          )
        };
      })();
    }
    return pending;
  }

  return {
    configure(value) {
      config = value;
      pending = undefined;
    },
    invalidate() {
      pending = undefined;
    },
    current,
    async page(filePath, consumes = false) {
      const pagePath = path.relative(root, filePath).split(path.sep).join('/');
      const state = await current();
      const page = state.pages.find((page) => page.pagePath === pagePath);
      if (consumes && page) consumers.add(filePath);
      return page ? { ...state, page, config } : undefined;
    },
    vitePlugin() {
      return {
        name: 'oxiquill-references',
        configureServer(server) {
          let timer;
          let revision = 0;
          let fingerprint;
          current()
            .then((state) => {
              fingerprint = state.fingerprint;
            })
            .catch(() => {});
          const listener = (event, file) => {
            const relative = path.relative(pathFromUrl(paths.docsDir), file);
            if (
              !['add', 'change', 'unlink'].includes(event) ||
              relative.startsWith('..') ||
              path.isAbsolute(relative) ||
              !/\.(md|mdx)$/u.test(file)
            )
              return;
            revision += 1;
            const expectedRevision = revision;
            pending = undefined;
            clearTimeout(timer);
            timer = setTimeout(async () => {
              try {
                const state = await current();
                if (expectedRevision !== revision || state.fingerprint === fingerprint) return;
                fingerprint = state.fingerprint;
                Object.values(server.environments).forEach(({ moduleGraph }) => {
                  consumers.forEach((consumer) => {
                    moduleGraph.getModulesByFile(consumer)?.forEach((module) => moduleGraph.invalidateModule(module));
                  });
                });
                server.ws.send({ type: 'full-reload' });
              } catch (error) {
                if (expectedRevision !== revision) return;
                fingerprint = undefined;
                server.ws.send({ type: 'error', err: { message: error.message, stack: error.stack } });
              }
            }, 50);
          };
          server.watcher.add(pathFromUrl(paths.docsDir));
          server.watcher.on('all', listener);
          server.httpServer?.once('close', () => {
            clearTimeout(timer);
            server.watcher.off('all', listener);
          });
        }
      };
    }
  };
}
