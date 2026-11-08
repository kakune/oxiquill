export function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? Object.freeze(parts) : undefined;
}

export function parseToolVersion(output, tool) {
  const match = output.trim().match(/^(\S+)[ \t]+(\S+)(?:[ \t]+\([^\r\n]*\))?$/u);
  if (!match || match[1] !== tool) return undefined;
  const version = match[2];
  const stableVersion = version?.replace(/-(?:beta\.\d+|nightly)$/u, '');
  return parseVersion(stableVersion);
}

export function compareVersions(left, right) {
  return left.map((part, index) => Math.sign(part - right[index])).find((difference) => difference !== 0) ?? 0;
}
