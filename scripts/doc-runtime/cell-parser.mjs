import YAML from 'yaml';
import { scopedCellId } from '../../src/lib/doc-runtime/authoring-ids.mjs';
import {
  normalizeCrates,
  normalizeInputs,
  normalizePackages,
  normalizeRunMode,
  normalizeTimeout
} from './cell-metadata.mjs';
import {
  sourceThemes,
  supportedLanguages
} from './constants.mjs';

const fencePattern = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
const optionPattern = /^\s*(?:(?:\/\/\/|\/\/|#)\|)\s?(.*)$/;

export async function extractCellsFromMarkdown(source, pagePath, context) {
  const cells = [];

  for (const match of source.matchAll(fencePattern)) {
    const language = parseLanguage(match[3]);
    if (!language) continue;

    const parsed = await parseCell(match[4], language, pagePath, context);
    if (parsed) cells.push(parsed);
  }

  return cells;
}

export function parseLanguage(info) {
  const raw = info.trim().split(/\s+/u)[0].replace(/[{}]/gu, '').replace(/^\./u, '');
  return supportedLanguages.get(raw);
}

export async function parseCell(rawSource, language, pagePath, context) {
  const { metadataLines, sourceLines } = splitCellSource(rawSource);

  if (metadataLines.length === 0) return undefined;

  const metadata = YAML.parse(metadataLines.join('\n')) ?? {};
  const localId = metadata.id;
  if (!localId || typeof localId !== 'string') {
    throw new Error(`Interactive ${language} cell in ${pagePath} is missing an id option.`);
  }

  const source = sourceLines.join('\n').trim();
  if (!source) {
    throw new Error(`Interactive cell "${localId}" in ${pagePath} does not contain code.`);
  }

  return {
    id: scopedCellId(pagePath, localId),
    language,
    title: String(metadata.title ?? localId),
    run: normalizeRunMode(metadata.run, localId, pagePath),
    source,
    sourceHtml: await context.highlighter.codeToHtml(source, {
      lang: language,
      themes: sourceThemes
    }),
    inputs: normalizeInputs(metadata.inputs, localId, pagePath),
    packages: normalizePackages(metadata.packages, language, metadata.id, pagePath),
    crates: normalizeCrates(metadata.crates, language, metadata.id, pagePath, context.helperCrates),
    timeoutMs: normalizeTimeout(metadata.timeoutMs, localId, pagePath),
    showSource: metadata.showSource !== false,
    pagePath
  };
}

export function splitCellSource(rawSource) {
  const metadataLines = [];
  const sourceLines = [];

  for (const line of rawSource.split('\n')) {
    const optionMatch = line.match(optionPattern);
    if (optionMatch) {
      metadataLines.push(optionMatch[1]);
    } else {
      sourceLines.push(line);
    }
  }

  return { metadataLines, sourceLines };
}
