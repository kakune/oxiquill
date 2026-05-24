export function createOxiquillCollections({ defineCollection, docsLoader, docsSchema }) {
  return {
    docs: defineCollection({
      loader: docsLoader(),
      schema: docsSchema()
    })
  };
}
