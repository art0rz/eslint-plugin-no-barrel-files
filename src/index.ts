import { TSESLint } from '@typescript-eslint/utils';
import noBarrelFiles from './rules/no-barrel-files';

const rules = {
  'no-barrel-files': noBarrelFiles,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;

// eslint-disable-next-line import/prefer-default-export
export { rules };
