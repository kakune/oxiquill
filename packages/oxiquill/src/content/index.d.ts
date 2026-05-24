import type { defineCollection } from 'astro:content';
import type { docsLoader } from '@astrojs/starlight/loaders';
import type { docsSchema } from '@astrojs/starlight/schema';

export interface OxiquillContentDependencies {
  defineCollection: typeof defineCollection;
  docsLoader: typeof docsLoader;
  docsSchema: typeof docsSchema;
}

export interface OxiquillCollections {
  docs: ReturnType<typeof defineCollection>;
}

export declare const collections: OxiquillCollections;

export declare function createOxiquillCollections(dependencies: OxiquillContentDependencies): OxiquillCollections;
