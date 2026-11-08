export const starlightTranslationsModuleId = 'virtual:oxiquill/starlight-translations';

const resolvedModuleId = `\0${starlightTranslationsModuleId}`;
// Starlight's prerendered docs route: `export async function getStaticPaths() { return paths; }`.
const staticRoutePattern = /[\\/]@astrojs[\\/]starlight[\\/](?:dist[\\/])?routes[\\/]static[\\/]index\.astro$/u;
const routingImportPattern = /^(?:\.\.\/)+utils\/routing(?:\/index(?:\.[cm]?[jt]s)?)?$/u;

/**
 * Serves Starlight's documentation routes without fallback pages for `missingTranslations: 'omit'`.
 *
 * Starlight has no option to skip the fallback routes it generates for untranslated pages. The
 * plugin answers the routing import of Starlight's static docs route with a module whose `paths`
 * omit those routes, so Astro never renders them. Route middleware and the language select read
 * the same module to keep navigation consistent with the generated pages.
 */
export function starlightTranslationsPlugin() {
  let staticRouteIntercepted = false;

  return {
    wasStaticRouteIntercepted: () => staticRouteIntercepted,
    plugin: {
      name: 'oxiquill-starlight-translations',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === starlightTranslationsModuleId) return resolvedModuleId;
        if (!importer || !routingImportPattern.test(source) || !staticRoutePattern.test(importer.split('?')[0]))
          return undefined;
        staticRouteIntercepted = true;
        return resolvedModuleId;
      },
      async load(id) {
        if (id !== resolvedModuleId) return undefined;
        const route = await this.resolve('@astrojs/starlight/routes/static/index.astro', undefined, { skipSelf: true });
        const routing = route ? await this.resolve('../../utils/routing', route.id, { skipSelf: true }) : null;
        if (!routing) {
          throw new Error(
            "Oxiquill could not locate Starlight's routing module for missingTranslations: 'omit'. Use a supported @astrojs/starlight version."
          );
        }
        return starlightTranslationsModule(routing.id);
      }
    }
  };
}

export function starlightTranslationsModule(routingId) {
  return [
    "import config from 'virtual:starlight/user-config';",
    "import project from 'virtual:starlight/project-context';",
    `import { paths as starlightPaths, routes } from ${JSON.stringify(routingId)};`,
    '',
    'if (starlightPaths.length !== routes.length) {',
    "  throw new Error(\"Oxiquill could not match Starlight's static paths to its routes for missingTranslations: 'omit'.\");",
    '}',
    '',
    'export const paths = starlightPaths.filter((_, index) => !routes[index].isFallback);',
    'export const translations = Object.freeze({',
    '  routeIds: new Set(routes.filter((route) => !route.isFallback).map((route) => route.id.normalize())),',
    '  fallbackRouteIds: new Set(routes.filter((route) => route.isFallback).map((route) => route.id.normalize())),',
    '  locales: Object.fromEntries(',
    '    Object.entries(config.locales ?? {}).map(([key, locale]) => [key, { label: locale.label, lang: locale.lang }])',
    '  ),',
    "  defaultLocale: config.defaultLocale?.locale === 'root' ? undefined : config.defaultLocale?.locale,",
    '  pagination: config.pagination,',
    '  trailingSlash: project.trailingSlash,',
    '  base: import.meta.env.BASE_URL',
    '});',
    ''
  ].join('\n');
}
