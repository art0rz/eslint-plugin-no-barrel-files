import { TSESLint } from '@typescript-eslint/utils';
import packageJson from '../package.json';
import noBarrelFiles from './rules/no-barrel-files';
import preferSourceImports from './rules/prefer-source-imports';

const rules = {
  'no-barrel-files': noBarrelFiles,
  'prefer-source-imports': preferSourceImports,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;

const pluginMeta = {
  name: 'eslint-plugin-no-barrel-files',
  version: packageJson.version,
} satisfies NonNullable<TSESLint.FlatConfig.Plugin['meta']>;

const runtimeMeta = {
  ...pluginMeta,
  namespace: 'no-barrel-files',
} as const;

const flatRecommendedConfig = {
  plugins: {
    'no-barrel-files': { meta: runtimeMeta, rules } as Omit<TSESLint.FlatConfig.Plugin, 'configs'>,
  },
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
    'no-barrel-files/prefer-source-imports': 'error',
  },
} satisfies TSESLint.FlatConfig.Config;

const legacyRecommendedConfig = {
  plugins: ['no-barrel-files'],
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
    'no-barrel-files/prefer-source-imports': 'error',
  },
} as const;

const configs = {
  recommended: legacyRecommendedConfig,
  'flat/recommended': [flatRecommendedConfig],
} as const;

const plugin = {
  meta: runtimeMeta,
  configs: configs as unknown as TSESLint.FlatConfig.Plugin['configs'],
  rules,
} as unknown as TSESLint.FlatConfig.Plugin & {
  configs: typeof configs;
  meta: typeof runtimeMeta;
};

export = plugin;
