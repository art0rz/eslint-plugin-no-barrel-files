import { AST_NODE_TYPES, TSESLint } from '@typescript-eslint/utils';

type MessageIds = 'noReExport' | 'noExportAll';

const noBarrelFiles: TSESLint.RuleModule<MessageIds> = {
  defaultOptions: [],
  meta: {
    type: 'suggestion',
    docs: {
      url: 'https://github.com/art0rz/eslint-plugin-no-barrel-files',
      description: 'disallow barrel files',
    },
    schema: [],
    messages: {
      noReExport: 'Do not re-export imported variable (`{{name}}`)',
      noExportAll: 'Do not use export all (`export * from ...`)',
    },
  },
  create(context) {
    const declaredImports: Array<string> = [];

    return {
      ExportDefaultDeclaration(node) {
        if (node.declaration.type === 'Identifier' && declaredImports.includes(node.declaration.name)) {
          context.report({
            node,
            messageId: 'noReExport',
            data: {
              name: node.declaration.name,
            },
          });
        }
      },
      ExportAllDeclaration(node) {
        context.report({
          node,
          messageId: 'noExportAll',
        });
      },
      ExportNamedDeclaration(node) {
        if (node?.source?.type === 'Literal') {
          context.report({
            node,
            messageId: 'noReExport',
            data: {
              name: node.source.value,
            },
          });
        }

        node.specifiers.forEach(specifier => {
          if (
            specifier.local.type === AST_NODE_TYPES.Identifier &&
            specifier.exported.type === AST_NODE_TYPES.Identifier &&
            declaredImports.includes(specifier.local.name)
          ) {
            context.report({
              node: specifier,
              messageId: 'noReExport',
              data: {
                name: specifier.exported.name,
              },
            });
          }
        });
      },
      ImportDeclaration(node) {
        node.specifiers.forEach(item => {
          declaredImports.push(item.local.name);
        });
      },
    };
  },
};

export default noBarrelFiles;
