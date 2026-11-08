import { translations } from 'virtual:oxiquill/starlight-translations';
import { applyTranslatedRouteData } from '../../lib/starlight/translations.js';
import type { TranslatableRouteData } from '../../lib/starlight/translations.js';

/**
 * Starlight route middleware for `missingTranslations: 'omit'`. It removes sidebar links, previous
 * and next links, and language alternates that point at fallback pages Oxiquill does not generate.
 */
export async function onRequest(
  context: { readonly locals: object; readonly site?: URL },
  next: () => Promise<void>
): Promise<void> {
  const route = (context.locals as { starlightRoute?: TranslatableRouteData }).starlightRoute;
  if (route) applyTranslatedRouteData(route, translations, context.site);
  await next();
}
