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
    add('source-changed', { changes });
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
  } else if (kind === 'source' && missing && desired.cellCount > 0) add('output-missing');
  return reasons.length ? reasons : [{ code: 'output-missing' }];
}

export function explainRuntimePlan({ plan, desired, state, mode, outputComplete, outputMissing = {}, forceRustBuild }) {
  return Object.fromEntries(
    Object.entries(plan.languages).map(([language, actions]) => [
      language,
      Object.fromEntries(
        Object.entries(actions).map(([kind, action]) => [
          kind,
          actionReasons({
            action,
            desired: desired[language],
            previous: state?.languages?.[language],
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
    ])
  );
}
