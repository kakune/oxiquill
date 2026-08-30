import assert from 'node:assert/strict';

export function checkMarkdownStructure(filePath, source) {
  const lines = visibleMarkdownLines(source);
  const headingLines = new Map();

  for (const { line, lineNumber } of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (!heading) continue;

    const slug = headingSlug(heading);
    const previousLine = headingLines.get(slug);
    assert.equal(
      previousLine,
      undefined,
      `${filePath}:${lineNumber} duplicates heading ${JSON.stringify(heading)} from line ${previousLine}.`
    );
    headingLines.set(slug, lineNumber);
  }

  lines.forEach((entry, index) => {
    const delimiterCells = tableCells(entry.line);
    if (!delimiterCells?.every((cell) => /^:?-{3,}:?$/u.test(cell))) return;

    const header = lines[index - 1];
    assert.ok(
      header && header.lineNumber === entry.lineNumber - 1,
      `${filePath}:${entry.lineNumber} has a table delimiter without a header.`
    );
    assertTableRow(filePath, header, delimiterCells.length);

    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      const previous = lines[rowIndex - 1];
      if (row.lineNumber !== previous.lineNumber + 1 || !tableCells(row.line)) break;
      assertTableRow(filePath, row, delimiterCells.length);
    }
  });
}

export function headingSlug(heading) {
  return heading
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

function assertTableRow(filePath, { line, lineNumber }, expectedColumns) {
  for (const match of line.matchAll(/(`+)(.*?)\1/gu)) {
    assert.ok(
      !hasUnescapedPipe(match[2]),
      `${filePath}:${lineNumber} contains an unescaped table separator inside inline code.`
    );
  }

  const cells = tableCells(line);
  assert.equal(
    cells?.length,
    expectedColumns,
    `${filePath}:${lineNumber} has ${cells?.length ?? 0} table columns; expected ${expectedColumns}.`
  );
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;

  const separators = Array.from(trimmed.matchAll(/\|/gu), (match) => match.index).filter(
    (index) => !isEscaped(trimmed, index)
  );
  if (separators[0] !== 0 || separators.at(-1) !== trimmed.length - 1) return undefined;

  return separators.slice(0, -1).map((start, index) => trimmed.slice(start + 1, separators[index + 1]).trim());
}

function hasUnescapedPipe(value) {
  return Array.from(value.matchAll(/\|/gu), (match) => match.index).some((index) => !isEscaped(value, index));
}

function isEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function visibleMarkdownLines(source) {
  const visible = [];
  let fence;

  source.split('\n').forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (!fence) visible.push({ line, lineNumber: index + 1 });
  });

  return visible;
}
