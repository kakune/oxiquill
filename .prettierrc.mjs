/** @type {import('prettier').Config} */
export default {
  endOfLine: 'lf',
  plugins: ['prettier-plugin-astro'],
  printWidth: 120,
  proseWrap: 'preserve',
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'none',
  overrides: [
    {
      files: '*.astro',
      options: {
        parser: 'astro'
      }
    }
  ]
};
