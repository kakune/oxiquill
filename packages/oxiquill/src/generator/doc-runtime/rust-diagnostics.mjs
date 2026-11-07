import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { hashText } from './hashing.mjs';

export function compilerMessages(output) {
  return String(output ?? '')
    .split('\n')
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value.reason === 'compiler-message' && value.message?.level === 'error'
          ? [{ ...value.message, targetFile: value.target?.src_path }]
          : [];
      } catch {
        return [];
      }
    });
}

export function isRustCompilerFailure(error) {
  const output = stripVTControlCharacters(`${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
  if (compilerMessages(output).length) return true;
  if (/(?:^|\n)\[INFO\]:[^\n]*(?:Installing wasm-bindgen|Optimizing wasm)/u.test(output)) return false;
  // wasm-pack prints rustc's human diagnostics. Require both a diagnostic header
  // and Cargo's compile summary; tool and resolver errors have neither pairing.
  return (
    /(?:^|\n)error(?:\[E\d+\])?:/u.test(output) &&
    /could not compile [`']/u.test(output) &&
    !/failed to run custom build command/u.test(output)
  );
}

function fileMap(fileName, files, cwd) {
  const candidates = files.filter((file) =>
    [path.resolve(cwd, fileName), path.resolve(file.crateDir, fileName)].includes(path.resolve(file.file))
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function mapRustSpan(span, files, cwd) {
  const file = fileMap(span.file_name, files, cwd);
  const raw = { file: span.file_name, line: span.line_start, column: span.column_start };
  if (!file) return { kind: 'external', ...raw, label: span.label, primary: span.is_primary };
  const start = file.regions.find(
    (region) => region.start <= span.byte_start && (span.byte_start < region.end || region.start === region.end)
  );
  const end =
    span.byte_end === span.byte_start
      ? start
      : file.regions.findLast((region) => region.start < span.byte_end && region.end >= span.byte_end);
  const covered = file.regions.filter((region) => region.end > span.byte_start && region.start < span.byte_end);
  const authored =
    start?.kind === 'authored' &&
    end?.kind === 'authored' &&
    start.cellId === end.cellId &&
    covered.every((region) => region.kind === 'authored' && region.cellId === start.cellId);
  if (!authored)
    return {
      kind: 'generated',
      ...raw,
      cellId: start?.cellId,
      region: start?.region ?? 'support',
      label: span.label,
      primary: span.is_primary
    };
  const position = (region, offset) => ({
    line: region.line,
    column:
      region.column +
      Array.from(
        Buffer.from(file.text)
          .subarray(region.start, offset)
          .toString('utf8')
          .replace(/\r?\n$/u, '')
      ).length
  });
  const from = position(start, span.byte_start);
  const to = position(end, span.byte_end);
  return {
    kind: 'authored',
    file: start.pagePath,
    cellId: start.cellId,
    ...from,
    endLine: to.line,
    endColumn: to.column,
    excerpt: start.text,
    label: span.label,
    primary: span.is_primary,
    generated: raw,
    ...(span.suggested_replacement != null
      ? { replacement: span.suggested_replacement, applicability: span.suggestion_applicability }
      : {})
  };
}

export function mapRustDiagnostic(message, files, cwd) {
  if (message.targetFile) files = files.filter((file) => path.resolve(file.file) === path.resolve(message.targetFile));
  const spans = (message.spans ?? []).map((span) => ({
    ...mapRustSpan(span, files, cwd),
    expansion: span.expansion?.span ? mapRustSpan(span.expansion.span, files, cwd) : undefined
  }));
  const edits = spans.filter((_, index) => message.spans[index].suggested_replacement != null);
  const translatedSuggestion = edits.length > 0 && edits.every((span) => span.kind === 'authored');
  return {
    level: message.level,
    code: message.code?.code,
    message: message.message,
    spans,
    ...(edits.length ? { translatedSuggestion } : {}),
    ...(!translatedSuggestion && edits.length
      ? { untranslatedEdits: message.spans.filter((span) => span.suggested_replacement != null) }
      : {}),
    children: (message.children ?? []).map((child) => mapRustDiagnostic(child, files, cwd)),
    rendered: message.rendered
  };
}

export function formatRustDiagnostic(diagnostic) {
  const locations = diagnostic.spans.map((span) =>
    span.kind !== 'authored' && span.expansion?.kind === 'authored' ? span.expansion : span
  );
  const primary = locations.find((span) => span.primary) ?? locations[0];
  const header = `${primary ? `${primary.file}:${primary.line}:${primary.column}${primary.cellId ? ` [cell ${primary.cellId}]` : ''}${primary.kind === 'generated' ? ` [generated ${primary.region}]` : ''}: ` : ''}${diagnostic.code ? `${diagnostic.code}: ` : ''}${diagnostic.message}`;
  const details = locations.flatMap((span) => {
    if (span.kind !== 'authored')
      return [`  ${span.file}:${span.line}:${span.column}${span.label ? `: ${span.label}` : ''}`];
    const start = Math.max(0, span.column - 41);
    const excerpt = Array.from(span.excerpt)
      .slice(start, start + 160)
      .join('')
      .replace(/\t/gu, ' ');
    return [
      `  ${span.file}:${span.line}:${span.column}`,
      `  ${excerpt}`,
      `  ${' '.repeat(Math.max(0, span.column - start - 1))}${'^'.repeat(Math.max(1, Math.min(160 - (span.column - start - 1), span.endLine === span.line ? span.endColumn - span.column : 1)))}${span.label ? ` ${span.label}` : ''}`,
      `  generated: ${span.generated.file}:${span.generated.line}:${span.generated.column}`
    ];
  });
  const children = diagnostic.children.map(formatRustDiagnostic);
  const suggestions = diagnostic.translatedSuggestion
    ? diagnostic.spans
        .filter((span) => span.replacement !== undefined)
        .map((span) => `  suggestion at ${span.file}:${span.line}:${span.column}: ${JSON.stringify(span.replacement)}`)
    : [];
  const untranslated =
    diagnostic.translatedSuggestion === false && diagnostic.rendered
      ? [`  untranslated suggestion: ${diagnostic.rendered.trim()}`]
      : [];
  return [
    header,
    ...details,
    ...children,
    ...suggestions,
    ...untranslated,
    ...(diagnostic.untranslatedEdits ? [`  untranslated edits: ${JSON.stringify(diagnostic.untranslatedEdits)}`] : [])
  ].join('\n');
}

// The original error remains the failure, regardless of the check pass outcome.
export async function diagnoseRustFailure({
  error,
  files = [],
  paths,
  mode,
  env,
  runCommand,
  packages = [],
  fileSystem
}) {
  if (!isRustCompilerFailure(error)) return error;
  let output;
  try {
    output = await runCommand(
      'cargo',
      [
        'check',
        '--manifest-path',
        path.join(paths.rustCellsDir, 'Cargo.toml'),
        '--locked',
        '--target',
        'wasm32-unknown-unknown',
        '--message-format=json',
        ...(mode === 'build' ? ['--release'] : []),
        ...packages.flatMap((name) => ['--package', name])
      ],
      { cwd: paths.workspaceRoot, env, captureOutput: true, source: 'cargo', phase: 'diagnostic' }
    );
  } catch (cause) {
    output = cause.stdout ?? '';
  }
  const verified = [];
  const pages = new Map();
  for (const file of files) {
    try {
      if (hashText(await fileSystem.readFile(file.file, 'utf8')) !== hashText(file.text)) continue;
      for (const region of file.regions.filter((region) => region.kind === 'authored')) {
        if (!pages.has(region.pagePath))
          pages.set(
            region.pagePath,
            String(await fileSystem.readFile(path.resolve(paths.workspaceRoot, region.pagePath), 'utf8')).split(
              /\r?\n/u
            )
          );
      }
      if (
        file.regions.every(
          (region) => region.kind !== 'authored' || pages.get(region.pagePath)?.[region.line - 1] === region.text
        )
      )
        verified.push(file);
    } catch {
      /* An unavailable source must never be mapped speculatively. */
    }
  }
  const diagnostics = compilerMessages(output).map((message) =>
    mapRustDiagnostic(message, verified, paths.rustCellsDir)
  );
  error.rustDiagnostics = diagnostics;
  error.message = `${diagnostics.length ? diagnostics.map(formatRustDiagnostic).join('\n\n') : ''}${!diagnostics.length || (files.length > 0 && !verified.length) ? '\ncould not map this error to an authored cell' : ''}\n\nOriginal build error:\n${error.message}`;
  return error;
}
