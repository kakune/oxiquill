import path from 'node:path';
import { writeIfChanged } from './file-system.mjs';

export const devDiagnosticsPath = (paths) => path.join(paths.buildCacheDir, 'rust-dev-diagnostics.json');

export function cellCompileErrors(diagnostics) {
  return diagnostics.flatMap((diagnostic) => {
    const spans = diagnostic.spans.flatMap((span) => [span, ...(span.expansion ? [span.expansion] : [])]);
    const owned = [...new Map(spans.filter((span) => span.cellId).map((span) => [span.cellId, span])).values()];
    return owned.map((span) => ({
      cellId: span.cellId,
      file: span.file,
      line: span.line,
      column: span.column,
      message: diagnostic.message,
      ...(diagnostic.code ? { code: diagnostic.code } : {})
    }));
  });
}

export async function writeDevDiagnostics({ paths, fileSystem, diagnostics = [], blocks = [] }) {
  await writeIfChanged(
    devDiagnosticsPath(paths),
    JSON.stringify({ version: 1, compileErrors: cellCompileErrors(diagnostics), failedBlocks: blocks }),
    { fileSystem }
  );
}
