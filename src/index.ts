import { TSESLint } from '@typescript-eslint/utils';
import noBarrelFiles from './rules/no-barrel-files';
import noImportsFromReExports from './rules/no-imports-from-re-exports';

const rules = {
  'no-barrel-files': noBarrelFiles,
  'no-imports-from-re-exports': noImportsFromReExports,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;

const plugin = {
  rules,
  flat: {
    plugins: {
      'no-barrel-files': {
        rules,
      },
    },
    rules: {
      'no-barrel-files/no-barrel-files': 'error',
      'no-barrel-files/no-imports-from-re-exports': 'error',
    },
  } satisfies TSESLint.FlatConfig.Config,
};

export = plugin;
