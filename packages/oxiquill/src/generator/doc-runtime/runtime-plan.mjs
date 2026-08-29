export const runtimeLanguages = Object.freeze(['rust', 'python', 'haskell']);

export function createRuntimePlan({ desired, forceRustBuild = false, mode, outputComplete, outputPresent, state }) {
  const previous = state?.languages ?? {};
  const rustSourceCurrent =
    desired.rust.cellCount > 0 &&
    previous.rust?.sourceFingerprint === desired.rust.sourceFingerprint &&
    outputComplete.rustSource;
  const rustBuildCurrent =
    rustSourceCurrent &&
    previous.rust?.buildFingerprint === desired.rust.buildFingerprint &&
    previous.rust?.status === 'ready' &&
    modeSatisfies(previous.rust?.mode, mode) &&
    outputComplete.rustPublic;
  const haskellSourceCurrent =
    desired.haskell.cellCount > 0 &&
    previous.haskell?.sourceFingerprint === desired.haskell.sourceFingerprint &&
    outputComplete.haskellSource;
  const haskellBuildCurrent =
    haskellSourceCurrent &&
    previous.haskell?.buildFingerprint === desired.haskell.buildFingerprint &&
    previous.haskell?.status === 'ready' &&
    modeSatisfies(previous.haskell?.mode, mode) &&
    outputComplete.haskellPublic;
  const pythonCurrent =
    desired.python.cellCount > 0 &&
    previous.python?.assetFingerprint === desired.python.assetFingerprint &&
    outputComplete.pythonPublic;

  const languages = {
    rust: {
      source:
        desired.rust.cellCount === 0
          ? outputPresent.rustSource || previous.rust
            ? 'remove'
            : 'keep'
          : rustSourceCurrent && !forceRustBuild
            ? 'keep'
            : 'write',
      public:
        desired.rust.cellCount === 0
          ? outputPresent.rustPublic || previous.rust?.publicFiles?.length > 0
            ? 'remove'
            : 'keep'
          : mode == null
            ? rustSourceCurrent
              ? 'keep'
              : 'remove'
            : rustBuildCurrent && !forceRustBuild
              ? 'keep'
              : 'build'
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
