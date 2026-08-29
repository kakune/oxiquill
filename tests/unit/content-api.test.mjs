// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

const { createOxiquillCollections } = await import('../../packages/oxiquill/src/content/index.ts');

describe('oxiquill/content', () => {
  it('creates Starlight collections from consumer-loaded dependencies', () => {
    const defineCollection = vi.fn((config) => config);
    const docsLoader = vi.fn(() => 'loader');
    const docsSchema = vi.fn(() => 'schema');

    expect(createOxiquillCollections({ defineCollection, docsLoader, docsSchema })).toEqual({
      docs: {
        loader: 'loader',
        schema: 'schema'
      }
    });
  });
});
