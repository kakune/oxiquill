import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = createOxiquillCollections({ defineCollection, docsLoader, docsSchema });

export function createOxiquillCollections({ defineCollection, docsLoader, docsSchema }) {
  return {
    docs: defineCollection({
      loader: docsLoader(),
      schema: docsSchema()
    })
  };
}
