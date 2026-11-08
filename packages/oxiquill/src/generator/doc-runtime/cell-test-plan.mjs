import path from 'node:path';
import { CliUsageError } from '../../cli/arguments.mjs';
import { pathFromUrl } from '../../config/paths.mjs';

export function createCellTestPlan(cells, values, paths) {
  const fail = (message) => {
    throw new CliUsageError(message, 'test-wasm');
  };
  const pages = [
    ...new Set(
      (values.page ?? []).map((value) => {
        const normalized = path.posix.normalize(value.replace(/\\/gu, '/'));
        if (
          path.posix.isAbsolute(normalized) ||
          /^[a-z]:/iu.test(normalized) ||
          normalized === '..' ||
          normalized.startsWith('../')
        )
          fail(`--page must be a docs-relative path: ${JSON.stringify(value)}.`);
        return normalized;
      })
    )
  ];
  const docsPrefix = path
    .relative(pathFromUrl(paths.workspaceRoot), pathFromUrl(paths.docsDir))
    .split(path.sep)
    .join('/');
  const pageOf = (cell) => path.posix.relative(docsPrefix, cell.pagePath);
  pages.forEach((page) => {
    if (!cells.some((cell) => pageOf(cell) === page)) fail(`--page matched no cells: ${JSON.stringify(page)}.`);
  });
  const pageCells = cells.filter((cell) => !pages.length || pages.includes(pageOf(cell)));
  const cellIds = [...new Set(values.cell ?? [])];
  const matchesCell = (cell, id) => cell.id === id || (pages.length === 1 && cell.localId === id);
  cellIds.forEach((id) => {
    const matched = pageCells.filter((cell) => matchesCell(cell, id));
    if (!matched.length)
      fail(
        `--cell matched no cells: ${JSON.stringify(id)}.${pages.length !== 1 ? ' Page-local ids require exactly one --page.' : ''}`
      );
    const unsupported = matched.find((cell) => cell.language !== 'rust');
    if (unsupported) fail(`test cases are not yet supported for ${unsupported.language} cells`);
    if (matched.some((cell) => cell.kind === 'definitions'))
      fail(`Definitions block ${JSON.stringify(id)} is not executable.`);
  });
  const selectedCells = pageCells.filter(
    (cell) =>
      cell.language === 'rust' &&
      cell.kind !== 'definitions' &&
      (!cellIds.length || cellIds.some((id) => matchesCell(cell, id)))
  );
  const tests = selectedCells.flatMap((cell) => {
    const declared = cell.tests ?? [];
    const defaults = Object.fromEntries(cell.inputs.map(({ name, value }) => [name, value]));
    const defaultTest = declared.find((test) => test.case === 'default') ?? { case: 'default', expect: [] };
    const candidates = [
      defaultTest,
      ...declared.filter((test) => test.case !== 'default'),
      ...(values['all-cases']
        ? (cell.cases ?? [])
            .filter(({ id }) => !declared.some((test) => test.case === id))
            .map(({ id }) => ({ case: id, expect: [] }))
        : [])
    ];
    return candidates.map((test) => ({
      cell,
      page: pageOf(cell),
      ...test,
      testIndex: declared.indexOf(test),
      inputs: test.case === 'default' ? defaults : cell.cases.find(({ id }) => id === test.case).inputs
    }));
  });
  const caseIds = [...new Set(values.case ?? [])];
  caseIds.forEach((id) => {
    if (!tests.some((test) => test.case === id))
      fail(`--case matched no runnable tests: ${JSON.stringify(id)}. Untested named cases require --all-cases.`);
  });
  const filtered = tests.filter((test) => !caseIds.length || caseIds.includes(test.case));
  const hasSelectors = pages.length > 0 || cellIds.length > 0 || caseIds.length > 0;
  if (hasSelectors && filtered.length === 0) fail('Selectors matched no runnable Rust tests.');
  return { tests: filtered, runHaskell: !hasSelectors };
}
