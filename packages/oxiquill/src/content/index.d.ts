export declare function createOxiquillCollections(dependencies: {
  defineCollection: (...args: any[]) => any;
  docsLoader: (...args: any[]) => any;
  docsSchema: (...args: any[]) => any;
}): Record<string, unknown>;
