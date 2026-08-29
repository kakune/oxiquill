import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultFileSystem } from './file-system.mjs';

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
