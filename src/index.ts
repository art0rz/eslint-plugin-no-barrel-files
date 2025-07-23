import { TSESLint } from '@typescript-eslint/utils';
import noBarrelFiles from './rules/no-barrel-files';

const rules = {
  'no-barrel-files': noBarrelFiles,
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
    },
  } satisfies TSESLint.FlatConfig.Config,
};

export = plugin;
