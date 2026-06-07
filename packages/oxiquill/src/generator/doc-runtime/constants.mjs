export const sourceThemes = {
  light: 'github-light',
  dark: 'github-dark'
};

export const supportedLanguages = new Map([
  ['rust', 'rust'],
  ['rs', 'rust'],
  ['python', 'python'],
  ['py', 'python'],
  ['haskell', 'haskell'],
  ['hs', 'haskell']
]);

export const runModes = ['button', 'reactive', 'autorun', 'hidden'];
export const inputTypes = ['range', 'number', 'integer', 'text', 'textarea', 'checkbox', 'select', 'radio'];

export const vendoredPyodidePackageRoots = ['matplotlib', 'pandas'];
export const supportedPyodidePackages = [
  'contourpy',
  'cycler',
  'fonttools',
  'kiwisolver',
  'matplotlib',
  'numpy',
  'packaging',
  'pandas',
  'pillow',
  'pyparsing',
  'python-dateutil',
  'pytz',
  'six'
];

export const rustReservedIdentifiers = new Set([
  'Self',
  'abstract',
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'do',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'final',
  'fn',
  'for',
  'gen',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'match',
  'mod',
  'move',
  'mut',
  'override',
  'priv',
  'pub',
  'ref',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'union',
  'unsafe',
  'unsized',
  'use',
  'virtual',
  'where',
  'while',
  'yield'
]);

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
