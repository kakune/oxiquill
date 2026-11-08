export const sourceThemes = {
  light: 'github-light-high-contrast',
  dark: 'github-dark-high-contrast'
};

export const vendoredPyodidePackageRoots = ['matplotlib', 'pandas'];
export { supportedPyodidePackages } from '../../lib/doc-runtime/cell-authoring.mjs';

export { rustReservedIdentifiers } from '../../lib/doc-runtime/rust-names.mjs';

export const haskellReservedIdentifiers = new Set([
  '_',
  'as',
  'case',
  'class',
  'data',
  'default',
  'deriving',
  'do',
  'else',
  'foreign',
  'hiding',
  'if',
  'import',
  'in',
  'infix',
  'infixl',
  'infixr',
  'instance',
  'let',
  'module',
  'newtype',
  'of',
  'qualified',
  'then',
  'type',
  'where'
]);
