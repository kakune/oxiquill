import { normalizeCell } from '../../lib/doc-runtime/normalized-cell.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';

export function sourceFingerprints(cells) {
  return Object.fromEntries(
    [...cells]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((cell) => [
        cell.id,
        {
          page: cell.pagePath,
          digest: hashText(
            stableFingerprint({
              source: cell.source,
              definitions: cell.definitions?.map(normalizeCell),
              uses: cell.uses,
              inputs: cell.inputs,
              crates: cell.crates,
              packages: cell.packages,
              setup: cell.setup
            })
          )
        }
      ])
  );
}

export function changedSources(previous = {}, desired = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(desired)])]
    .sort()
    .flatMap((id) =>
      previous[id]?.digest === desired[id]?.digest ? [] : [{ page: (desired[id] ?? previous[id]).page, cell: id }]
    );
}

export function pageSourceFingerprints(sources) {
  return Object.fromEntries(
    Object.entries(Object.groupBy(Object.entries(sources), ([, record]) => record.page))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([page, entries]) => [
        page,
        hashText(
          stableFingerprint(entries.sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => [id, record.digest]))
        )
      ])
  );
}

function storedInputs(value) {
  if (!value) return {};
  try {
    const artifact = JSON.parse(value);
    return JSON.parse(artifact.inputs);
  } catch {
    return {};
  }
}

export function actionReasons({ action, desired, previous, kind, mode, forced = false, complete, missing, sources }) {
  if (action === 'keep') return [{ code: desired.cellCount === 0 ? 'absent' : 'cache-hit' }];
  const reasons = [];
  const add = (code, details = {}) => reasons.push({ code, ...details });
  const before = storedInputs(previous?.buildFingerprint);
  const after = storedInputs(JSON.stringify({ inputs: desired.buildFingerprint }));
  const changes = changedSources(previous?.sources, sources);
  if (previous?.sourceFingerprint !== desired.sourceFingerprint || changes.length || desired.cellCount === 0) {
    const attributed = changes.length
      ? changes
      : Object.entries(sources ?? previous?.sources ?? {})
          .map(([cell, record]) => ({ page: record.page, cell }))
          .sort((a, b) => a.cell.localeCompare(b.cell));
    add('source-changed', { changes: attributed });
  }
  if (forced) add('forced');
  if (kind === 'public' && desired.cellCount > 0) {
    if (missing) add('output-missing');
    else if (!complete) add('integrity-mismatch');
    if (previous?.status && previous.status !== 'ready') add('previous-build-failed');
    if (mode === 'build' && previous?.mode === 'dev') add('mode-upgrade');
    for (const [field, code] of [
      ['helpers', 'helper-inputs-changed'],
      ['toolchain', 'toolchain-changed'],
      ['generatorIdentity', 'generator-changed'],
      ['package', 'package-changed']
    ]) {
      if (stableFingerprint(before[field]) !== stableFingerprint(after[field])) add(code);
    }
    if (before.rustBuildInputs !== after.rustBuildInputs) {
      const oldOptions = previous?.buildOptions ?? {};
      const nextOptions = desired.buildOptions ?? {};
      const variables = [...new Set([...Object.keys(oldOptions), ...Object.keys(nextOptions)])]
        .filter((name) => oldOptions[name] !== nextOptions[name])
        .sort();
      add('build-options-changed', { variables });
    }
    if (previous?.assetFingerprint !== desired.assetFingerprint) add('package-changed');
  } else if (kind === 'source' && desired.cellCount > 0) {
    if (missing) add('output-missing');
    else if (complete === false) add('integrity-mismatch');
  }
  return reasons.length ? reasons : [{ code: 'output-missing' }];
}

export function explainRuntimePlan({ plan, desired, state, mode, outputComplete, outputMissing = {}, forceRustBuild }) {
  return Object.fromEntries(
    Object.entries(plan.languages).map(([language, actions]) => {
      const recorded = state?.languages?.[language];
      const previous = recorded
        ? {
            ...recorded,
            sources:
              recorded.sources ??
              sourceFingerprints((state.snapshot?.cells ?? []).filter((cell) => cell.language === language))
          }
        : undefined;
      return [
        language,
        Object.fromEntries(
          Object.entries(actions).map(([kind, action]) => [
            kind,
            actionReasons({
              action,
              desired: desired[language],
              previous,
              kind,
              mode,
              forced: language === 'rust' && forceRustBuild,
              complete: outputComplete[`${language}${kind === 'source' ? 'Source' : 'Public'}`],
              missing:
                outputMissing[`${language}${kind === 'source' ? 'Source' : 'Public'}`] ?? !state?.languages?.[language],
              sources: desired[language].sources
            })
          ])
        )
      ];
    })
  );
}
