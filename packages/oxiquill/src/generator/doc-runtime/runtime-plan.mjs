import { artifactBuildFingerprint } from './build-inputs.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';

export const runtimeLanguages = Object.freeze(['rust', 'python', 'haskell']);

// Rust actions come from the module-group plan (`rust`); this function only
// decides removal when no Rust cells remain.
export function createRuntimePlan({ desired, mode, outputComplete, outputPresent, rust, state }) {
  const previous = state?.languages ?? {};
  const haskellSourceCurrent =
    desired.haskell.cellCount > 0 &&
    previous.haskell?.sourceFingerprint === desired.haskell.sourceFingerprint &&
    outputComplete.haskellSource;
  const haskellBuildCurrent =
    haskellSourceCurrent &&
    previous.haskell?.buildFingerprint ===
      artifactBuildFingerprint(desired.haskell.buildFingerprint, previous.haskell?.mode) &&
    previous.haskell?.status === 'ready' &&
    modeSatisfies(previous.haskell?.mode, mode) &&
    outputComplete.haskellPublic;
  const pythonCurrent =
    desired.python.cellCount > 0 &&
    previous.python?.assetFingerprint === desired.python.assetFingerprint &&
    outputComplete.pythonPublic;

  const languages = {
    rust:
      desired.rust.cellCount > 0
        ? { source: rust?.source ?? 'write', public: rust?.public ?? (mode == null ? 'remove' : 'build') }
        : {
            source: outputPresent.rustSource || previous.rust ? 'remove' : 'keep',
            public:
              outputPresent.rustPublic || previous.rust?.publicFiles?.length > 0 || state?.rust?.modules?.length > 0
                ? 'remove'
                : 'keep'
          },
    python: {
      public:
        desired.python.cellCount === 0
          ? outputPresent.pythonPublic || previous.python
            ? 'remove'
            : 'keep'
          : pythonCurrent
            ? 'keep'
            : 'copy'
    },
    haskell: {
      source:
        desired.haskell.cellCount === 0
          ? outputPresent.haskellSource || previous.haskell
            ? 'remove'
            : 'keep'
          : haskellSourceCurrent
            ? 'keep'
            : 'write',
      public:
        desired.haskell.cellCount === 0
          ? outputPresent.haskellPublic || previous.haskell?.publicFiles?.length > 0
            ? 'remove'
            : 'keep'
          : mode == null
            ? haskellSourceCurrent
              ? 'keep'
              : 'remove'
            : haskellBuildCurrent
              ? 'keep'
              : 'build'
    }
  };
  const languageChanges = Object.values(languages).some((actions) =>
    Object.values(actions).some((action) => action !== 'keep')
  );
  const generatedChanged =
    !outputComplete.generated ||
    state?.generationId !== desired.generationId ||
    state?.snapshot?.referenceId !== desired.referenceId ||
    (desired.referenceSnapshotFingerprint !== undefined &&
      desired.referenceSnapshotFingerprint !== hashText(stableFingerprint(state?.snapshot?.pages))) ||
    state?.manifestFingerprint !== desired.manifestFingerprint ||
    state?.schemaVersion !== 1 ||
    languageChanges;

  return Object.freeze({
    generated: generatedChanged ? 'write' : 'keep',
    hasChanges: generatedChanged || languageChanges,
    languages: Object.freeze({
      rust: Object.freeze(languages.rust),
      python: Object.freeze(languages.python),
      haskell: Object.freeze(languages.haskell)
    })
  });
}

function modeSatisfies(actual, requested) {
  if (requested == null) return true;
  if (requested === 'dev') return actual === 'dev' || actual === 'build';
  return actual === 'build';
}
