export function parseRuntimeLockRecord(source) {
  try {
    const record = JSON.parse(source);
    return record &&
      ['token', 'host', 'command', 'startedAt', 'oxiquillVersion'].every(
        (field) => typeof record[field] === 'string' && record[field].length > 0
      ) &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      Number.isFinite(Date.parse(record.startedAt))
      ? Object.freeze(record)
      : undefined;
  } catch {
    return undefined;
  }
}

export function isRuntimeLockFile(name) {
  return name === 'runtime.lock' || /^runtime\.lock\.(?:candidate|reclaim|stale)-[a-f0-9-]+$/u.test(name);
}

export function describeRuntimeLock(lockPath, record, host) {
  const details = record
    ? `${record.command}, PID ${record.pid}, host ${record.host}, started ${record.startedAt}`
    : undefined;
  if (!record || record.host !== host) {
    return `Runtime lock ${lockPath} is held by an unknown owner.${details ? ` Recorded holder: ${details}.` : ''} If no Oxiquill process is running, remove ${lockPath} manually.`;
  }
  return `Runtime lock ${lockPath} is held by ${details}.`;
}
