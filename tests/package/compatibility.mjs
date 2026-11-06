import semver from 'semver';

export function minimumDependencies(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      const minimum = semver.minVersion(range);
      if (!minimum) throw new Error(`No minimum version for ${name}: ${range}`);
      return [name, minimum.version];
    })
  );
}

export function compatibilityManifest(starter, published, profile, packageManager) {
  if (!['starter', 'lowest', 'highest'].includes(profile)) throw new Error(`Unknown compatibility profile: ${profile}`);
  if (profile === 'starter') return starter;
  const peers = profile === 'lowest' ? minimumDependencies(published.peerDependencies) : published.peerDependencies;
  const internal = minimumDependencies(published.dependencies);
  return {
    ...starter,
    dependencies: { ...starter.dependencies, ...peers },
    ...(profile === 'lowest' && packageManager === 'npm' ? { overrides: { oxiquill: internal } } : {})
  };
}

export function compatibilityWorkspace(published, profile) {
  return {
    minimumReleaseAge: 0,
    resolutionMode: profile === 'lowest' ? 'lowest-direct' : 'highest',
    ...(profile === 'lowest'
      ? {
          overrides: Object.fromEntries(
            Object.entries(minimumDependencies(published.dependencies)).map(([name, version]) => [
              `oxiquill>${name}`,
              version
            ])
          )
        }
      : {})
  };
}
