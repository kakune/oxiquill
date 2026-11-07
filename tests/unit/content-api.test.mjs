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
    const { extend } = docsSchema.mock.calls[0][0];
    expect(extend.parse({ references: { demo: 'heading' } })).toEqual({ references: { demo: 'heading' } });
    expect(extend.parse({})).toEqual({});
    expect(extend.safeParse({ references: { demo: 1 } }).success).toBe(false);
  });
});
