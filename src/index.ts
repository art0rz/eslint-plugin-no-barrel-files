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

const flatDefaultConfig = {
  plugins: {
    'no-barrel-files': { meta: runtimeMeta, rules } as Omit<TSESLint.FlatConfig.Plugin, 'configs'>,
  },
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
  },
} satisfies TSESLint.FlatConfig.Config;

const flatRecommendedConfig = {
  ...flatDefaultConfig,
  rules: {
    ...flatDefaultConfig.rules,
    'no-barrel-files/prefer-source-imports': 'error',
  },
} satisfies TSESLint.FlatConfig.Config;

const legacyDefaultConfig = {
  plugins: ['no-barrel-files'],
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
  },
} as const;

const legacyRecommendedConfig = {
  plugins: ['no-barrel-files'],
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
    'no-barrel-files/prefer-source-imports': 'error',
  },
} as const;

const configs = {
  default: legacyDefaultConfig,
  recommended: legacyRecommendedConfig,
  'flat/default': [flatDefaultConfig],
  'flat/recommended': [flatRecommendedConfig],
  'legacy-default': legacyDefaultConfig,
  'legacy-recommended': legacyRecommendedConfig,
} as const;

const plugin = {
  meta: runtimeMeta,
  configs: configs as unknown as TSESLint.FlatConfig.Plugin['configs'],
  rules,
  flat: flatDefaultConfig,
} as unknown as TSESLint.FlatConfig.Plugin & {
  configs: typeof configs;
  flat: TSESLint.FlatConfig.Config;
  meta: typeof runtimeMeta;
};

export = plugin;
