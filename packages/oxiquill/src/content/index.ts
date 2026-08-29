type Callable = (...args: never[]) => unknown;

export interface OxiquillContentDependencies<
  DefineCollection extends Callable,
  DocsLoader extends Callable,
  DocsSchema extends Callable
> {
  defineCollection: DefineCollection;
  docsLoader: DocsLoader;
  docsSchema: DocsSchema;
}

export interface OxiquillCollections<DefineCollection extends Callable> {
  docs: ReturnType<DefineCollection>;
}

export function createOxiquillCollections<
  DefineCollection extends Callable,
  DocsLoader extends Callable,
  DocsSchema extends Callable
>({
  defineCollection,
  docsLoader,
  docsSchema
}: OxiquillContentDependencies<
  DefineCollection,
  DocsLoader,
  DocsSchema
>): OxiquillCollections<DefineCollection> {
  const createCollection = defineCollection as unknown as (options: {
    loader: ReturnType<DocsLoader>;
    schema: ReturnType<DocsSchema>;
  }) => ReturnType<DefineCollection>;

  return {
    docs: createCollection({
      loader: docsLoader() as ReturnType<DocsLoader>,
      schema: docsSchema() as ReturnType<DocsSchema>
    })
  };
}
