import { TSESLint, AST_NODE_TYPES } from '@typescript-eslint/utils';

type MessageIds = 'messageIdForSomeFailure' | 'messageIdForSomeOtherFailure';

const myRule: TSESLint.RuleModule<MessageIds> = {
  defaultOptions: [],
  meta: {
    type: 'suggestion',
    docs: {
      url: '',
      description: 'require foo',
    },
    fixable: 'code',
    schema: [],
    messages: {
      messageIdForSomeFailure: 'Error message for some failure',
      messageIdForSomeOtherFailure: 'Error message for some other failure',
    },
  },
  create(context) {
    // declare the state of the rule

    return {
      CallExpression(node) {
        // we only care about the callees that have a name (see below)
        if (node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (node.callee.name === 'foo') {
          context.report({
            node: node.callee,
            messageId: 'messageIdForSomeFailure',
          });
        }
        if (node.callee.name === 'bar') {
          context.report({
            node: node.callee,
            messageId: 'messageIdForSomeOtherFailure',
          });
        }
      },
    };
  },
};

export default myRule;
