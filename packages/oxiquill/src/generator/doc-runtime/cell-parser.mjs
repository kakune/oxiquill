import { parsePageFrontmatter } from '../../lib/doc-runtime/references.mjs';
import { hashText } from './hashing.mjs';
import { normalizeCell } from '../../lib/doc-runtime/normalized-cell.mjs';
import { resolveRustDefinitions } from '../../lib/doc-runtime/rust-definitions.mjs';
import { resolveDataDependencies } from '../../lib/doc-runtime/cell-data-dependencies.mjs';
import { unified } from 'unified';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import {
  parseInteractiveCellNode,
  resolvePythonSetups,
  throwInteractiveCellDiagnostics,
  validateCellDependencies
} from '../../lib/doc-runtime/cell-authoring.mjs';
import { visit } from '../../lib/doc-runtime/remark-mdx-helpers.mjs';
import { sourceThemes } from './constants.mjs';
import { assertUniqueCellIds } from './validators.mjs';

const markdownParser = unified().use(remarkParse).use(remarkMath);
const mdxParser = unified().use(remarkParse).use(remarkMath).use(remarkMdx);

export function parseCellsFromMarkdown(source, pagePath, pythonOptions = {}) {
  const parser = String(pagePath).endsWith('.mdx') ? mdxParser : markdownParser;
  const metadata = parsePageFrontmatter(source, pagePath);
  const tree = parser.parse(metadata.body);
  const cells = [];
  const diagnostics = [];

  visit(tree, (node) => {
    if (!node || typeof node !== 'object') return;
    const result = parseInteractiveCellNode(node, pagePath, pythonOptions, source);
    if (result.kind === 'cell') cells.push({ ...result.cell, pageFingerprint: hashText(source) });
    if (result.kind === 'invalid') diagnostics.push(...result.diagnostics);
  });

  const links = [];
  const headings = [];
  visit(tree, (node) => {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'link' || node.type === 'definition') && node.url.startsWith('oxref:')) links.push(node.url);
    if (node.type === 'heading') headings.push(node);
  });
  return {
    cells,
    diagnostics,
    tree,
    page: {
      pagePath,
      slug: metadata.frontmatter.slug,
      references: metadata.references,
      cellReferences: cells
        .filter((cell) => cell.ref)
        .map((cell) => ({ name: cell.ref, cellId: cell.id, position: cell.refPosition })),
      links,
      headingSignature: metadata.references.length
        ? JSON.stringify(headings, (key, value) => (key === 'position' ? undefined : value))
        : undefined
    }
  };
}

export async function extractCellsFromMarkdown(source, pagePath, context) {
  const parsed = parseCellsFromMarkdown(source, pagePath, context.pythonOptions);
  const diagnostics = [
    ...parsed.diagnostics,
    ...parsed.cells.flatMap((cell) => validateCellDependencies(cell, context.helperCrates))
  ];
  throwInteractiveCellDiagnostics(diagnostics);
  assertUniqueCellIds(parsed.cells);
  // Same resolution steps as runtime collection (see cell-collection.mjs).
  return Promise.all(
    resolveDataDependencies(resolveRustDefinitions(resolvePythonSetups(parsed.cells))).map((cell) =>
      createCellManifest(cell, context.highlighter)
    )
  );
}

export async function createCellManifest(cell, highlighter) {
  const normalized = normalizeCell(cell);
  delete normalized.tests;
  return {
    ...normalized,
    sourceHtml: await highlighter.codeToHtml(cell.source, {
      lang: cell.language,
      themes: sourceThemes
    })
  };
}
