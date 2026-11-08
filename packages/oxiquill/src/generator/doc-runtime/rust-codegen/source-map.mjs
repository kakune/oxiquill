// Offsets use the same UTF-8 byte domain as rustc, never JavaScript string indices.
export function generatedFragment(text, cell, region = 'support') {
  return {
    text,
    regions: text
      ? [
          {
            start: 0,
            end: Buffer.byteLength(text),
            kind: 'generated',
            region,
            ...(cell ? { cellId: cell.id, pagePath: cell.pagePath } : {})
          }
        ]
      : []
  };
}

export function authoredFragment(cell) {
  const lines = cell.source.split('\n');
  let start = 0;
  return {
    text: cell.source,
    regions: lines.map((text, index) => {
      const end = start + Buffer.byteLength(text) + (index < lines.length - 1 ? 1 : 0);
      const position = cell.sourcePosition?.[index] ?? {
        line: (cell.fenceStartLine ?? 0) + index + 1,
        column: 1,
        text: text.replace(/\r$/u, '')
      };
      const region = {
        start,
        end,
        kind: 'authored',
        cellId: cell.id,
        pagePath: cell.pagePath,
        ...(cell.pageFingerprint ? { pageFingerprint: cell.pageFingerprint } : {}),
        ...position,
        source: text.replace(/\r$/u, '')
      };
      start = end;
      return region;
    })
  };
}

export function joinFragments(fragments) {
  let offset = 0;
  const regions = fragments.flatMap((fragment) => {
    const shifted = fragment.regions.map((region) => ({
      ...region,
      start: region.start + offset,
      end: region.end + offset
    }));
    offset += Buffer.byteLength(fragment.text);
    return shifted;
  });
  return { text: fragments.map((fragment) => fragment.text).join(''), regions };
}
