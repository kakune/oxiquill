import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultFileSystem } from './file-system.mjs';

const transientCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Windows briefly refuses renames and removals while another process (an
// editor, indexer, antivirus, or the dev server) holds a file open.
export async function retryFileOperation(
  action,
  { platform = process.platform, attempts = 6, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (platform !== 'win32' || attempt >= attempts || !transientCodes.has(error?.code)) throw error;
      await delay(25 * 2 ** (attempt - 1));
    }
  }
}

export async function createDirectoryStage(targetPath, { fileSystem = defaultFileSystem } = {}) {
  const stagePath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.oxiquill-${randomUUID()}`);
  await fileSystem.rm(stagePath, { force: true, recursive: true });
  await fileSystem.mkdir(stagePath, { recursive: true });
  return stagePath;
}

export async function replaceDirectory(stagePath, targetPath, { fileSystem = defaultFileSystem } = {}) {
  const backupPath = `${stagePath}.previous`;
  const targetExists = fileSystem.existsSync(targetPath);
  await fileSystem.rm(backupPath, { force: true, recursive: true });

  if (targetExists) await fileSystem.rename(targetPath, backupPath);
  try {
    await fileSystem.rename(stagePath, targetPath);
  } catch (error) {
    if (targetExists) await fileSystem.rename(backupPath, targetPath);
    throw error;
  }

  await fileSystem.rm(backupPath, { force: true, recursive: true });
}

export async function discardDirectoryStage(stagePath, { fileSystem = defaultFileSystem } = {}) {
  await fileSystem.rm(stagePath, { force: true, recursive: true });
}

// The generated directory goes last: withdraw its old ready marker first and
// expose the new one only after all language outputs have been installed.
export async function publishDirectoryStages(stages, { fileSystem = defaultFileSystem, onPublished = () => {} } = {}) {
  const changes = stages.map(({ stagePath, targetPath }) => ({
    stagePath,
    targetPath,
    backupPath: path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.oxiquill-${randomUUID()}.previous`),
    backedUp: false,
    installed: false
  }));
  try {
    for (const change of [...changes].reverse()) {
      if (fileSystem.existsSync(change.targetPath)) {
        await retryFileOperation(() => fileSystem.rename(change.targetPath, change.backupPath));
        change.backedUp = true;
      }
    }
    for (const change of changes) {
      if (change.stagePath) {
        await retryFileOperation(() => fileSystem.rename(change.stagePath, change.targetPath));
        change.installed = true;
      }
    }
  } catch (error) {
    for (const change of [...changes].reverse()) {
      if (change.installed) await fileSystem.rm(change.targetPath, { force: true, recursive: true });
    }
    for (const change of changes) {
      if (change.backedUp) await fileSystem.rename(change.backupPath, change.targetPath);
    }
    throw error;
  }
  // From this point the new ready marker is visible. Cleanup errors must not
  // cause callers to discard assets referenced by the committed generation.
  onPublished();
  await Promise.all(
    changes
      .filter(({ backedUp }) => backedUp)
      .map(({ backupPath }) => fileSystem.rm(backupPath, { force: true, recursive: true }))
  );
}
