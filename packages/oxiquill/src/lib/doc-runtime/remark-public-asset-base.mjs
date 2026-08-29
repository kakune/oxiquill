import { visit } from './remark-mdx-helpers.mjs';

const publicAssetPrefixes = ['/media/'];
const urlAttributes = new Set(['href', 'src']);

export default function remarkPublicAssetBase({ base = '' } = {}) {
  const normalizedBase = normalizeBase(base);
  if (!normalizedBase) return () => undefined;

  return (tree) => {
    visit(tree, (node) => {
      if (!node || typeof node !== 'object') return;

      if (typeof node.url === 'string') {
        node.url = withPublicAssetBase(node.url, normalizedBase);
      }

      if (Array.isArray(node.attributes)) {
        for (const attribute of node.attributes) {
          if (!isUrlAttribute(attribute)) continue;
          attribute.value = withPublicAssetBase(attribute.value, normalizedBase);
        }
      }
    });
  };
}

export function withPublicAssetBase(url, base) {
  if (!shouldPrefixPublicAsset(url, base)) return url;
  return `${base}${url}`;
}

function shouldPrefixPublicAsset(url, base) {
  return publicAssetPrefixes.some((prefix) => url.startsWith(prefix)) && !url.startsWith(`${base}/`);
}

function isUrlAttribute(attribute) {
  return (
    attribute &&
    attribute.type === 'mdxJsxAttribute' &&
    urlAttributes.has(attribute.name) &&
    typeof attribute.value === 'string'
  );
}

function normalizeBase(base) {
  if (!base || base === '/') return '';
  const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}
