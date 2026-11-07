// Authored locations and syntax highlighting are deliberately absent: prose edits
// must not change the identity of an otherwise identical interactive cell.
export function normalizeCell(cell) {
  return {
    id: cell.id,
    language: cell.language,
    title: cell.title,
    run: cell.run,
    source: cell.source,
    ...(cell.setup ? { setup: cell.setup } : {}),
    inputs: cell.inputs,
    packages: cell.packages,
    crates: cell.crates,
    timeoutMs: cell.timeoutMs,
    showSource: cell.showSource,
    editable: cell.editable,
    pagePath: cell.pagePath
  };
}
