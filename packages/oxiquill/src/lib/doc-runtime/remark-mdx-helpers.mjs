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
