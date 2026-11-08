// Development keeps every failing group's last working module. Its pages keep
// their previous Rust cells and definitions (complete pages, so `uses` and
// `dependsOn` stay consistent); other pages and languages are current. Applying
// the composition to an already composed manifest yields the same result.
export function composeRustManifest({ cells, definitions = [], groups, previousManifest, previousModules }) {
  const failed = groups.filter((group) => group.status === 'failed');
  const failedPages = new Set(failed.flatMap((group) => group.cells.map((cell) => cell.pagePath)));
  const isFailedRust = (entry) => entry.language === 'rust' && failedPages.has(entry.pagePath);
  const currentCells = cells.filter((cell) => !isFailedRust(cell));
  const currentDefinitions = definitions.filter((entry) => !isFailedRust(entry));
  const taken = new Set([...currentCells, ...currentDefinitions].map((entry) => entry.id));
  const modules = groups.filter((group) => group.status !== 'failed').map((group) => group.module);
  const retainedCells = [];
  const retainedDefinitions = [];
  const published = new Set(modules.map((module) => module.id));
  for (const group of failed) {
    const descriptor = previousModules.get(group.id);
    if (!descriptor || published.has(descriptor.id)) continue;
    const pages = new Set(group.cells.map((cell) => cell.pagePath));
    const kept = (previousManifest?.cells ?? []).filter(
      (cell) =>
        cell.language === 'rust' &&
        pages.has(cell.pagePath) &&
        descriptor.cells.includes(cell.id) &&
        !taken.has(cell.id)
    );
    if (!kept.length) continue;
    kept.forEach((cell) => taken.add(cell.id));
    retainedCells.push(...kept);
    retainedDefinitions.push(
      ...(previousManifest?.definitions ?? []).filter((entry) => pages.has(entry.pagePath) && !taken.has(entry.id))
    );
    modules.push({ ...descriptor, cells: kept.map((cell) => cell.id).sort() });
    published.add(descriptor.id);
  }
  return {
    cells: [...currentCells, ...retainedCells],
    definitions: [...currentDefinitions, ...retainedDefinitions],
    registry: { version: 1, modules: modules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) },
    retained: [...published].filter((id) => failed.some((group) => group.id === id)).sort()
  };
}

export function failedRustBlocks(blocks, groups) {
  const failedPages = new Set(
    groups.filter((group) => group.status === 'failed').flatMap((group) => group.cells.map((cell) => cell.pagePath))
  );
  return blocks.filter((block) => block.language === 'rust' && failedPages.has(block.pagePath));
}
