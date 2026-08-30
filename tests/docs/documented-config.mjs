import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadDocumentedConsumerConfig(repositoryRoot) {
  const contentRoot = path.join(repositoryRoot, 'examples/docs-site/content/docs');
  const sourcePaths = [
    path.join(contentRoot, 'guides/project-configuration.mdx'),
    path.join(contentRoot, 'ja/guides/project-configuration.mdx')
  ];
  const sectionHeadings = ['Minimal Configuration', '最小構成'];
  const sources = await Promise.all(sourcePaths.map((sourcePath) => readFile(sourcePath, 'utf8')));
  const configs = sources.map((source, index) => {
    const section = sectionUnderHeading(source, sectionHeadings[index], sourcePaths[index]);
    return {
      astro: codeFenceContaining(section, 'js', 'defineOxiquillConfig', sourcePaths[index]),
      content: codeFenceContaining(section, 'ts', 'createOxiquillCollections', sourcePaths[index])
    };
  });

  assert.deepEqual(configs[1], configs[0], 'English and Japanese minimal configuration snippets must stay identical.');
  return configs[0];
}

function sectionUnderHeading(source, heading, sourcePath) {
  const marker = `## ${heading}\n`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${sourcePath} must contain the ${heading} section.`);

  const sectionStart = markerIndex + marker.length;
  const sectionEnd = source.indexOf('\n## ', sectionStart);
  return source.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
}

function codeFenceContaining(source, language, token, sourcePath) {
  const fences = Array.from(source.matchAll(new RegExp(`^\`\`\`${language}[^\\n]*\\n([\\s\\S]*?)^\`\`\``, 'gmu')))
    .map((match) => match[1])
    .filter((code) => code.includes(token));

  assert.equal(fences.length, 1, `${sourcePath} must contain exactly one ${language} snippet using ${token}.`);
  return fences[0];
}
