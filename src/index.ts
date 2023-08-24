import { TSESLint } from '@typescript-eslint/utils';
import myRule from './rules/no-barrel-files';

const rules = {
  'no-barrel-files': myRule,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;

export default {
  rules,
};
