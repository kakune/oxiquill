import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];
const typescriptFiles = ['**/*.{ts,tsx}'];
const astroVirtualTypescriptFiles = ['*.astro/*.ts', '**/*.astro/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/.astro/**',
      '**/.cache/**',
      '**/.oxiquill/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/public/oxiquill/**',
      '**/target/**',
      '**/test-results/**',
      '**/pkg/**'
    ]
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error'
    }
  },
  {
    ...js.configs.recommended,
    files: javascriptFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: typescriptFiles,
    ignores: astroVirtualTypescriptFiles
  })),
  ...astro.configs['flat/recommended'],
  {
    files: ['**/*.astro'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  }
);
