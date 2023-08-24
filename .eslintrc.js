/* eslint-env node */
module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'airbnb-base',
    'airbnb-typescript/base',
    'prettier',
    'plugin:eslint-plugin/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.dev.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier'],
  root: true,
  rules: {
    'prettier/prettier': 'error',
  },
  env: {
    node: true,
  },
  overrides: [
    {
      files: ['src/rules/*.{js,ts}'],
      extends: ['plugin:eslint-plugin/rules'],
    },
    {
      files: ['src/rules/tests/*.{js,ts}'],
      extends: ['plugin:eslint-plugin/tests'],
    },
    {
      // allow imports from devDependencies in these files
      files: ['vitest.config.ts'],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          {
            devDependencies: true,
          },
        ],
      },
    },
  ],
};
