import { unified } from 'unified';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import {
  parseInteractiveCellNode,
  throwInteractiveCellDiagnostics,
  validateCellDependencies
} from '../../lib/doc-runtime/cell-authoring.mjs';
import { visit } from '../../lib/doc-runtime/remark-mdx-helpers.mjs';
import { sourceThemes } from './constants.mjs';
import { assertUniqueCellIds } from './validators.mjs';

const markdownParser = unified().use(remarkParse);
const mdxParser = unified().use(remarkParse).use(remarkMath).use(remarkMdx);

export function parseCellsFromMarkdown(source, pagePath) {
  const parser = String(pagePath).endsWith('.mdx') ? mdxParser : markdownParser;
  const tree = parser.parse(source);
  const cells = [];
  const diagnostics = [];

  visit(tree, (node) => {
    const result = parseInteractiveCellNode(node, pagePath);
    if (result.kind === 'cell') cells.push(result.cell);
    if (result.kind === 'invalid') diagnostics.push(...result.diagnostics);
  });

  return { cells, diagnostics, tree };
}

export async function extractCellsFromMarkdown(source, pagePath, context) {
  const parsed = parseCellsFromMarkdown(source, pagePath);
  const diagnostics = [
    ...parsed.diagnostics,
    ...parsed.cells.flatMap((cell) => validateCellDependencies(cell, context.helperCrates))
  ];
  throwInteractiveCellDiagnostics(diagnostics);
  assertUniqueCellIds(parsed.cells);
  return Promise.all(parsed.cells.map((cell) => createCellManifest(cell, context.highlighter)));
}

export async function createCellManifest(cell, highlighter) {
  return {
    id: cell.id,
    language: cell.language,
    title: cell.title,
    run: cell.run,
    source: cell.source,
    sourceHtml: await highlighter.codeToHtml(cell.source, {
      lang: cell.language,
      themes: sourceThemes
    }),
    inputs: cell.inputs,
    packages: cell.packages,
    crates: cell.crates,
    timeoutMs: cell.timeoutMs,
    showSource: cell.showSource,
    pagePath: cell.pagePath
  };
}
