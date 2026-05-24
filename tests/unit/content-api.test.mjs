// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

const contentMocks = vi.hoisted(() => ({
  defineCollection: vi.fn((config) => ({ collection: config }))
}));

vi.mock('astro:content', () => ({
  defineCollection: contentMocks.defineCollection
}));

const { collections, createOxiquillCollections } = await import('../../packages/oxiquill/src/content/index.mjs');

describe('oxiquill/content', () => {
  it('exports ready-to-use Starlight collections', () => {
    expect(collections.docs.collection.loader.name).toBe('starlight-docs-loader');
    expect(collections.docs.collection.schema).toEqual(expect.any(Function));
  });

  it('keeps a collection factory for compatibility', () => {
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
