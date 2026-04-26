import { TSESLint } from '@typescript-eslint/utils';
import noBarrelFiles from './rules/no-barrel-files';
import preferSourceImports from './rules/prefer-source-imports';

const rules = {
  'no-barrel-files': noBarrelFiles,
  'prefer-source-imports': preferSourceImports,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;

const pluginMeta = {
  name: 'eslint-plugin-no-barrel-files',
  version: '1.4.0',
} satisfies NonNullable<TSESLint.FlatConfig.Plugin['meta']>;

const runtimeMeta = {
  ...pluginMeta,
  namespace: 'no-barrel-files',
} as const;

const recommendedConfig = {
  plugins: {
    'no-barrel-files': { meta: runtimeMeta, rules } as Omit<TSESLint.FlatConfig.Plugin, 'configs'>,
  },
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
  },
} satisfies TSESLint.FlatConfig.Config;

const configs = {
  recommended: [recommendedConfig],
  'flat/recommended': [recommendedConfig],
  'legacy-recommended': {
    plugins: ['no-barrel-files'],
    rules: {
      'no-barrel-files/no-barrel-files': 'error',
    },
  },
} as const;

const plugin = {
  meta: runtimeMeta,
  configs: configs as unknown as TSESLint.FlatConfig.Plugin['configs'],
  rules,
  flat: recommendedConfig,
} as unknown as TSESLint.FlatConfig.Plugin & {
  configs: typeof configs;
  flat: TSESLint.FlatConfig.Config;
  meta: typeof runtimeMeta;
};

export = plugin;
