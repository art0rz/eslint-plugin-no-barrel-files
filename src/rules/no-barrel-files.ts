import path from 'node:path';
import { AST_NODE_TYPES, TSESLint } from '@typescript-eslint/utils';
import { minimatch } from 'minimatch';

type MessageIds = 'noReExport' | 'noExportAll';
type Options = [{ allow?: string[] }];

function isAllowedBarrel(filename: string, options: Options[0] | undefined): boolean {
  if (!options?.allow) {
    return false;
  }

  const normalizedFilename = filename.split(path.sep).join('/');
  const relativeFilename = path.relative(process.cwd(), filename).split(path.sep).join('/');

  return options.allow.some(
    pattern =>
      minimatch(relativeFilename, pattern, { dot: true }) || minimatch(normalizedFilename, pattern, { dot: true }),
  );
}

const noBarrelFiles: TSESLint.RuleModule<MessageIds, Options> = {
  defaultOptions: [{}],
  meta: {
    type: 'suggestion',
    docs: {
      url: 'https://github.com/art0rz/eslint-plugin-no-barrel-files',
      description: 'disallow barrel files',
    },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      noReExport: 'Do not re-export imported variable (`{{name}}`)',
      noExportAll: 'Do not use export all (`export * from ...`)',
    },
  },
  create(context) {
    const [options] = context.options;

    return {
      'Program:exit'(program) {
        if (isAllowedBarrel(context.filename, options)) return;

        const declaredImports = new Set(
          program.body.flatMap(statement =>
            statement.type === AST_NODE_TYPES.ImportDeclaration
              ? statement.specifiers.map(specifier => specifier.local.name)
              : [],
          ),
        );

        program.body.forEach(node => {
          if (node.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
            if (node.declaration.type === AST_NODE_TYPES.Identifier && declaredImports.has(node.declaration.name)) {
              context.report({
                node,
                messageId: 'noReExport',
                data: { name: node.declaration.name },
              });
            }

            return;
          }

          if (node.type === AST_NODE_TYPES.ExportAllDeclaration) {
            context.report({
              node,
              messageId: 'noExportAll',
            });

            return;
          }

          if (node.type !== AST_NODE_TYPES.ExportNamedDeclaration) {
            return;
          }

          if (node.source?.type === 'Literal') {
            context.report({
              node,
              messageId: 'noReExport',
              data: { name: node.source.value },
            });
          }

          node.specifiers.forEach(specifier => {
            if (
              specifier.local.type === AST_NODE_TYPES.Identifier &&
              specifier.exported.type === AST_NODE_TYPES.Identifier &&
              declaredImports.has(specifier.local.name)
            ) {
              context.report({
                node: specifier,
                messageId: 'noReExport',
                data: { name: specifier.exported.name },
              });
            }
          });
        });
      },
    };
  },
};

export default noBarrelFiles;
