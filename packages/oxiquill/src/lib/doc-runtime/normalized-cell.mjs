// Authored locations and syntax highlighting are deliberately absent: prose edits
// must not change the identity of an otherwise identical interactive cell.
export function normalizeCell(cell) {
  if (cell.kind === 'definitions')
    return {
      kind: 'definitions',
      id: cell.id,
      language: cell.language,
      title: cell.title,
      source: cell.source,
      crates: cell.crates,
      uses: cell.uses ?? [],
      showSource: cell.showSource,
      pagePath: cell.pagePath
    };
  return {
    id: cell.id,
    ...(cell.exports ? { exports: cell.exports, producerFingerprint: cell.producerFingerprint } : {}),
    ...(cell.dependsOn ? { dependsOn: cell.dependsOn } : {}),
    ...(cell.cache ? { cache: cell.cache } : {}),
    ...(cell.ref !== undefined ? { ref: cell.ref } : {}),
    language: cell.language,
    title: cell.title,
    run: cell.run,
    source: cell.source,
    ...(cell.uses?.length ? { uses: cell.uses } : {}),
    ...(cell.setup ? { setup: cell.setup } : {}),
    inputs: cell.inputs,
    ...(cell.cases?.length ? { cases: cell.cases } : {}),
    ...(cell.tests?.length ? { tests: cell.tests.map(({ case: caseId, expect }) => ({ case: caseId, expect })) } : {}),
    packages: cell.packages,
    crates: cell.crates,
    timeoutMs: cell.timeoutMs,
    showSource: cell.showSource,
    editable: cell.editable,
    ...(cell.outputLayout ? { outputLayout: cell.outputLayout } : {}),
    pagePath: cell.pagePath
  };
}
