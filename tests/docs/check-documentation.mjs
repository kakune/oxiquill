import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const contentRoot = path.join(repositoryRoot, 'examples/docs-site/content/docs');
const publicRoot = path.join(repositoryRoot, 'examples/docs-site/public');
const markdownPaths = [
  path.join(repositoryRoot, 'README.md'),
  path.join(repositoryRoot, 'CONTRIBUTING.md'),
  path.join(repositoryRoot, 'CHANGELOG.md'),
  path.join(repositoryRoot, 'SECURITY.md'),
  path.join(repositoryRoot, 'packages/oxiquill/README.md'),
  ...(await markdownFiles(path.join(repositoryRoot, 'docs'))),
  ...(await markdownFiles(contentRoot))
].sort();
const documents = new Map(
  await Promise.all(markdownPaths.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')]))
);
const documentsPackageJson = await readFile(path.join(repositoryRoot, 'packages/oxiquill/package.json'), 'utf8');
const documentsPackageJsonRoot = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
const documentsTemplatePackageJson = await readFile(path.join(repositoryRoot, 'templates/basic/package.json'), 'utf8');

await checkLinks();
await checkLocalizedRoutes();
await checkSidebarRoutes();
await checkPublicContracts();
checkJsonExamples();
checkPackageImports();
checkShellCommands();

console.log(
  `Verified ${documents.size} documentation files, internal links, localized routes, contracts, and examples.`
);

async function checkLinks() {
  const linkPattern = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

  for (const [sourcePath, source] of documents) {
    for (const match of source.matchAll(linkPattern)) {
      const rawTarget = match[1].replace(/^<|>$/gu, '');
      if (/^(?:https?:|mailto:)/u.test(rawTarget)) continue;

      const [target, fragment] = rawTarget.split('#', 2);
      if (!target) {
        assertFragment(sourcePath, source, fragment);
        continue;
      }

      const resolved = target.startsWith('/')
        ? await resolveSiteTarget(sourcePath, target)
        : await resolveRelativeTarget(sourcePath, target);
      await assertExists(resolved, sourcePath, rawTarget);

      if (fragment && /\.(?:md|mdx)$/u.test(resolved)) {
        const targetSource = documents.get(resolved) ?? (await readFile(resolved, 'utf8'));
        assertFragment(resolved, targetSource, fragment, sourcePath);
      }
    }
  }
}

async function resolveRelativeTarget(sourcePath, target) {
  const decoded = decodeURIComponent(target.split('?', 1)[0]);
  const fileTarget = path.resolve(path.dirname(sourcePath), decoded);
  if (await exists(fileTarget)) return fileTarget;
  if (!sourcePath.startsWith(contentRoot) || path.extname(decoded)) return fileTarget;

  const sourceSlug = relativeTo(contentRoot, sourcePath)
    .replace(/\.mdx$/u, '')
    .replace(/(^|\/)index$/u, '$1');
  const routeUrl = new URL(decoded, `https://oxiquill.local/${sourceSlug.replace(/^\/+|\/+$/gu, '')}/`);
  const targetSlug = routeUrl.pathname.replace(/^\/+|\/+$/gu, '') || 'index';
  return path.join(contentRoot, `${targetSlug}.mdx`);
}

async function resolveSiteTarget(sourcePath, target) {
  const route = decodeURIComponent(target.split(/[?#]/u, 1)[0]);
  if (route.startsWith('/media/')) return path.join(publicRoot, route.slice(1));

  assert.ok(
    sourcePath.startsWith(contentRoot),
    `${relative(sourcePath)} uses site route ${target} outside the dogfood content tree.`
  );

  const slug = route.replace(/^\/+|\/+$/gu, '') || 'index';
  const candidates = [path.join(contentRoot, `${slug}.mdx`), path.join(contentRoot, slug, 'index.mdx')];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return candidates[0];
}

async function checkLocalizedRoutes() {
  const contentPaths = await markdownFiles(contentRoot);
  const english = contentPaths
    .map((filePath) => relativeTo(contentRoot, filePath))
    .filter((filePath) => !filePath.startsWith('ja/') && filePath !== '404.mdx')
    .sort();
  const japanese = contentPaths
    .map((filePath) => relativeTo(contentRoot, filePath))
    .filter((filePath) => filePath.startsWith('ja/'))
    .map((filePath) => filePath.slice('ja/'.length))
    .sort();

  assert.deepEqual(japanese, english, 'English and Japanese consumer routes must have identical slugs.');
}

async function checkSidebarRoutes() {
  const configPath = path.join(repositoryRoot, 'examples/docs-site/astro.config.mjs');
  const config = await readFile(configPath, 'utf8');
  const slugs = Array.from(config.matchAll(/slug:\s*'([^']+)'/gu), (match) => match[1]);

  for (const slug of slugs) {
    const englishPath = path.join(contentRoot, `${slug}.mdx`);
    const japanesePath = path.join(contentRoot, 'ja', `${slug}.mdx`);
    await assertExists(englishPath, configPath, slug);
    await assertExists(japanesePath, configPath, `ja/${slug}`);
  }
}

async function checkPublicContracts() {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'packages/oxiquill/package.json'), 'utf8'));
  const apiReferences = [
    documents.get(path.join(contentRoot, 'reference/package-api.mdx')),
    documents.get(path.join(contentRoot, 'ja/reference/package-api.mdx'))
  ];
  const publicSpecifiers = Object.keys(packageJson.exports).map((key) =>
    key === '.' ? packageJson.name : `${packageJson.name}${key.slice(1)}`
  );

  for (const specifier of publicSpecifiers) {
    for (const reference of apiReferences) {
      assert.ok(reference.includes(`\`${specifier}\``), `Package API reference is missing ${specifier}.`);
    }
  }

  const pathsSource = await readFile(path.join(repositoryRoot, 'packages/oxiquill/src/config/paths.mjs'), 'utf8');
  const pathFields = new Set(Array.from(pathsSource.matchAll(/options\.([A-Za-z]+)\s*\?\?/gu), (match) => match[1]));
  const configReferences = [
    documents.get(path.join(contentRoot, 'guides/project-configuration.mdx')),
    documents.get(path.join(contentRoot, 'ja/guides/project-configuration.mdx'))
  ];
  for (const field of pathFields) {
    for (const reference of configReferences) {
      assert.ok(reference.includes(`\`${field}\``), `Project configuration reference is missing ${field}.`);
    }
  }

  const cliSource = await readFile(path.join(repositoryRoot, 'packages/oxiquill/src/cli/commands.mjs'), 'utf8');
  const implementedCommands = Array.from(cliSource.matchAll(/case '([^']+)':/gu), (match) => match[1]).filter(
    (command) => !['help', '--help', '-h'].includes(command)
  );
  const targetCommands = new Set([...implementedCommands, 'init']);
  const cliReferences = [
    documents.get(path.join(contentRoot, 'reference/cli.mdx')),
    documents.get(path.join(contentRoot, 'ja/reference/cli.mdx'))
  ];
  for (const command of targetCommands) {
    for (const reference of cliReferences) {
      assert.ok(reference.includes(`\`${command}`), `CLI reference is missing ${command}.`);
    }
  }
  for (const option of ['--help', '-h', '--version', '--debug', '--config', '--']) {
    for (const reference of cliReferences) {
      assert.ok(reference.includes(option), `CLI reference is missing ${option}.`);
    }
  }

  const outputReferences = [
    documents.get(path.join(contentRoot, 'features/rich-output.mdx')),
    documents.get(path.join(contentRoot, 'ja/features/rich-output.mdx'))
  ];
  for (const discriminator of [
    'text',
    'json',
    'table',
    'chart',
    'image',
    'html',
    'line',
    'scatter',
    'bar',
    'histogram',
    'area',
    'heatmap'
  ]) {
    for (const reference of outputReferences) {
      assert.ok(reference.includes(`\`${discriminator}\``), `Rich-output reference is missing ${discriminator}.`);
    }
  }
}

function checkJsonExamples() {
  for (const [filePath, source] of documents) {
    for (const match of source.matchAll(/^```json[^\n]*\n([\s\S]*?)^```/gmu)) {
      assert.doesNotThrow(
        () => JSON.parse(match[1]),
        undefined,
        `${relative(filePath)} contains an invalid JSON example.`
      );
    }
  }
}

function checkPackageImports() {
  const packageJson = JSON.parse(documentsPackageJson);
  const publicSpecifiers = new Set(
    Object.keys(packageJson.exports).map((key) =>
      key === '.' ? packageJson.name : `${packageJson.name}${key.slice(1)}`
    )
  );

  for (const [filePath, source] of documents) {
    for (const match of source.matchAll(/from\s+['"](oxiquill(?:\/[^'"]+)?)['"]/gu)) {
      assert.ok(publicSpecifiers.has(match[1]), `${relative(filePath)} imports undocumented package path ${match[1]}.`);
    }
  }
}

function checkShellCommands() {
  const rootPackage = JSON.parse(documentsPackageJsonRoot);
  const templatePackage = JSON.parse(documentsTemplatePackageJson);
  const scripts = new Set([...Object.keys(rootPackage.scripts), ...Object.keys(templatePackage.scripts)]);
  const pnpmBuiltins = new Set(['--dir', 'add', 'audit', 'dlx', 'exec', 'install', 'run']);
  const npmBuiltins = new Set(['audit', 'deprecate', 'install', 'pack', 'publish', 'stage']);
  const cliCommands = new Set([
    'init',
    'dev',
    'dev:runtime',
    'dev:astro',
    'build',
    'preview',
    'check',
    'docgen',
    'clean',
    'test-rust',
    'test-rust-coverage',
    'lint-rust',
    'doc-rust',
    'test-wasm'
  ]);

  for (const [filePath, source] of documents) {
    for (const fence of source.matchAll(/^```(?:sh|shell|bash)[^\n]*\n([\s\S]*?)^```/gmu)) {
      for (const rawLine of fence[1].split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const words = line.split(/\s+/u);

        if (words[0] === 'pnpm') {
          const command = words[1];
          if (pnpmBuiltins.has(command)) continue;
          assert.ok(scripts.has(command), `${relative(filePath)} references unknown pnpm script ${command}.`);
        } else if (words[0] === 'npm') {
          const command = words[1];
          if (command === 'run') {
            assert.ok(scripts.has(words[2]), `${relative(filePath)} references unknown npm script ${words[2]}.`);
          } else {
            assert.ok(npmBuiltins.has(command), `${relative(filePath)} references unsupported npm command ${command}.`);
          }
        } else if (words[0] === 'oxiquill') {
          assert.ok(
            cliCommands.has(words[1]),
            `${relative(filePath)} references unknown Oxiquill command ${words[1]}.`
          );
        }
      }
    }
  }
}

function assertFragment(targetPath, source, fragment, sourcePath = targetPath) {
  const anchors = new Set(Array.from(source.matchAll(/^#{1,6}\s+(.+)$/gmu), (match) => headingSlug(match[1])));
  assert.ok(
    anchors.has(decodeURIComponent(fragment)),
    `${relative(sourcePath)} links to missing fragment #${fragment} in ${relative(targetPath)}.`
  );
}

function headingSlug(heading) {
  return heading
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(entryPath);
      return /\.(?:md|mdx)$/u.test(entry.name) ? [entryPath] : [];
    })
  );
  return nested.flat();
}

async function assertExists(targetPath, sourcePath, link) {
  assert.ok(await exists(targetPath), `${relative(sourcePath)} links to missing target ${link}.`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relative(filePath) {
  return relativeTo(repositoryRoot, filePath);
}

function relativeTo(directory, filePath) {
  return path.relative(directory, filePath).split(path.sep).join('/');
}
