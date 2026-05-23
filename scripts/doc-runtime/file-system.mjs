import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { hashBytes } from './hashing.mjs';

export const defaultFileSystem = {
  copyFile,
  existsSync,
  mkdir,
  readFile,
  readdir,
  writeFile
};

export async function listFiles(directory, { fileSystem = defaultFileSystem } = {}) {
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath, { fileSystem });
      return entry.isFile() ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}

export async function writeIfChanged(filePath, content, { fileSystem = defaultFileSystem } = {}) {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });

  if (await hasTextContent(filePath, content, { fileSystem })) return false;

  await fileSystem.writeFile(filePath, content, 'utf8');
  return true;
}

export async function copyFileIfChanged(sourcePath, targetPath, { fileSystem = defaultFileSystem } = {}) {
  await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });

  if (await hasBinaryContent(sourcePath, targetPath, { fileSystem })) return false;

  await fileSystem.copyFile(sourcePath, targetPath);
  return true;
}

export async function hasPackageContent(filePath, sha256, { fileSystem = defaultFileSystem } = {}) {
  try {
    return hashBytes(await fileSystem.readFile(filePath)) === sha256;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasTextContent(filePath, content, { fileSystem }) {
  try {
    return (await fileSystem.readFile(filePath, 'utf8')) === content;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasBinaryContent(sourcePath, targetPath, { fileSystem }) {
  try {
    const [source, target] = await Promise.all([
      fileSystem.readFile(sourcePath),
      fileSystem.readFile(targetPath)
    ]);
    return Buffer.compare(source, target) === 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
