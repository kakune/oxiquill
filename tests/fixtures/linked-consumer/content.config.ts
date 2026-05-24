import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { createOxiquillCollections } from 'oxiquill/content';

export const collections = createOxiquillCollections({ defineCollection, docsLoader, docsSchema });
