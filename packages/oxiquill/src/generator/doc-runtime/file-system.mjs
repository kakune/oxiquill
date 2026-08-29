import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { hashBytes } from './hashing.mjs';

export const defaultFileSystem = {
  copyFile,
  existsSync,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
};

export async function listFiles(directory, { fileSystem = defaultFileSystem } = {}) {
  const directoryPath = pathFromUrl(directory);
  const entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath, { fileSystem });
      return entry.isFile() ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}

export async function writeIfChanged(filePath, content, { fileSystem = defaultFileSystem } = {}) {
  const targetPath = pathFromUrl(filePath);
  await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });

  if (await hasTextContent(targetPath, content, { fileSystem })) return false;

  await fileSystem.writeFile(targetPath, content, 'utf8');
  return true;
}

export async function copyFileIfChanged(sourcePath, targetPath, { fileSystem = defaultFileSystem } = {}) {
  const sourceFilePath = pathFromUrl(sourcePath);
  const targetFilePath = pathFromUrl(targetPath);
  await fileSystem.mkdir(path.dirname(targetFilePath), { recursive: true });

  if (await hasBinaryContent(sourceFilePath, targetFilePath, { fileSystem })) return false;

  await fileSystem.copyFile(sourceFilePath, targetFilePath);
  return true;
}

export async function hasPackageContent(filePath, sha256, { fileSystem = defaultFileSystem } = {}) {
  const targetPath = pathFromUrl(filePath);
  try {
    return hashBytes(await fileSystem.readFile(targetPath)) === sha256;
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
    const [source, target] = await Promise.all([fileSystem.readFile(sourcePath), fileSystem.readFile(targetPath)]);
    return Buffer.compare(source, target) === 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
