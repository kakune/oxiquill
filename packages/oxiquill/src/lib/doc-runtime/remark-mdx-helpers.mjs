import path from 'node:path';

export function visit(node, callback) {
  callback(node);

  if (!node || typeof node !== 'object') return;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, callback);
      }
    }
  }
}

export function collectReservedMdxIdentifiers(tree) {
  const identifiers = new Set();

  visit(tree, (node) => {
    if (!node || typeof node !== 'object') return;

    if (/^mdxJsx(?:Flow|Text)Element$/u.test(node.type) && typeof node.name === 'string') {
      identifiers.add(node.name.split('.', 1)[0]);
    }

    collectEstreeIdentifiers(node.data?.estree, identifiers, new Set());
  });

  return identifiers;
}

export function allocateMdxIdentifier(reservedIdentifiers, preferredName) {
  let suffix = 0;
  let candidate = preferredName;

  while (reservedIdentifiers.has(candidate)) {
    suffix += 1;
    candidate = `${preferredName}${suffix}`;
  }

  reservedIdentifiers.add(candidate);
  return candidate;
}

export function relativeImport(fromFile, toFile, fallback) {
  if (!fromFile) return fallback;

  const relativePath = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

export function createDefaultImport(name, importPath) {
  return {
    type: 'mdxjsEsm',
    value: `import ${name} from '${importPath}';`,
    data: {
      estree: {
        type: 'Program',
        sourceType: 'module',
        body: [
          {
            type: 'ImportDeclaration',
            specifiers: [
              {
                type: 'ImportDefaultSpecifier',
                local: { type: 'Identifier', name }
              }
            ],
            source: { type: 'Literal', value: importPath, raw: `'${importPath}'` }
          }
        ]
      }
    }
  };
}

export function expressionAttribute(name, value) {
  const raw = JSON.stringify(value);

  return {
    type: 'mdxJsxAttribute',
    name,
    value: {
      type: 'mdxJsxAttributeValueExpression',
      value: raw,
      data: {
        estree: {
          type: 'Program',
          sourceType: 'module',
          body: [
            {
              type: 'ExpressionStatement',
              expression: { type: 'Literal', value, raw }
            }
          ]
        }
      }
    }
  };
}

export function identifierAttribute(name, identifier) {
  return {
    type: 'mdxJsxAttribute',
    name,
    value: {
      type: 'mdxJsxAttributeValueExpression',
      value: identifier,
      data: {
        estree: {
          type: 'Program',
          sourceType: 'module',
          body: [
            {
              type: 'ExpressionStatement',
              expression: { type: 'Identifier', name: identifier }
            }
          ]
        }
      }
    }
  };
}

function collectEstreeIdentifiers(value, identifiers, visited) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);

  if (value.type === 'Identifier' && typeof value.name === 'string') identifiers.add(value.name);

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      child.forEach((entry) => collectEstreeIdentifiers(entry, identifiers, visited));
    } else {
      collectEstreeIdentifiers(child, identifiers, visited);
    }
  }
}
