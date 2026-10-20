import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
import { minimatch } from 'minimatch';
import {
  createAnalysisCaches,
  collectAllExportedBindings,
  collectBarrelAnalysis,
  collectExportedBindings,
  parseBarrelFile,
  parseExportedBindings,
  parseModule,
  resolveReExportTarget,
} from './prefer-source-imports/analysis';
import {
  buildAutofix,
  buildNamespaceAutofix,
  getMergeableImportDeclaration,
  isTypeOnlyImport,
  serializeImportBinding,
  serializeImportBindings,
} from './prefer-source-imports/autofix';
import {
  applyAliasTarget,
  buildAliasSpecifier,
  isRelativePath,
  matchesAliasPattern,
  normalizeModulePath,
  resolveModuleFile,
  toRelativeImportSpecifier,
} from './prefer-source-imports/path-utils';
import {
  createImportResolver,
  createResolutionCaches,
  createSharedResolutionCaches,
  getManualAliasMappings,
  getPreferredSourceSpecifier,
  getTypeScriptModule,
  hasTypeScriptModule,
  getTsconfigInfo,
  getTsconfigPath,
  resolveImport,
  resolveWithManualPaths,
  resolveWithTsconfig,
  reverseResolveManualAlias,
  reverseResolveTsconfigAlias,
  setTypeScriptModuleLoaderForTests,
} from './prefer-source-imports/resolution';
import {
  MatchedSpecifier,
  MessageIds,
  NamedImportSpecifier,
  Options,
  SupportedImportSpecifier,
} from './prefer-source-imports/types';

function isNamedImportSpecifier(specifier: TSESTree.ImportClause): specifier is NamedImportSpecifier {
  return (
    specifier.type === AST_NODE_TYPES.ImportSpecifier &&
    specifier.imported.type === AST_NODE_TYPES.Identifier &&
    specifier.local.type === AST_NODE_TYPES.Identifier
  );
}

function isSupportedImportSpecifier(specifier: TSESTree.ImportClause): specifier is SupportedImportSpecifier {
  return specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier || isNamedImportSpecifier(specifier);
}

function shouldReportMissingTypeScript(_filename: string, options: Options[0] | undefined): boolean {
  return options?.tsconfig !== false && !hasTypeScriptModule();
}

const preferSourceImports: TSESLint.RuleModule<MessageIds, Options> = {
  defaultOptions: [{}],
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      url: 'https://github.com/art0rz/eslint-plugin-no-barrel-files',
      description: 'prefer importing from source modules instead of barrel re-exports',
    },
    schema: [
      {
        type: 'object',
        properties: {
          fixStyle: {
            type: 'string',
            enum: ['auto', 'preserve-alias', 'relative'],
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
          },
          tsconfig: {
            anyOf: [{ type: 'boolean' }, { type: 'string' }],
          },
          paths: {
            type: 'object',
            additionalProperties: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: { type: 'string' },
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingTypeScript:
        "prefer-source-imports requires the 'typescript' package when tsconfig resolution is enabled. Install 'typescript' in the consuming project or set 'tsconfig: false'.",
      preferSourceImport: "Import '{{name}}' directly from '{{source}}' instead of barrel '{{barrel}}'.",
      preferSourceImports: "Import directly from source modules instead of barrel '{{barrel}}'.",
    },
  },
  create(context) {
    const [options] = context.options;
    const sourceCode = context.sourceCode;
    const resolver = createImportResolver(options, process.cwd());
    const missingTypeScript = shouldReportMissingTypeScript(context.filename, options);

    return {
      Program(node) {
        if (!missingTypeScript) {
          return;
        }

        context.report({
          node,
          messageId: 'missingTypeScript',
        });
      },
      ImportDeclaration(node) {
        if (missingTypeScript) {
          return;
        }

        if (!node.source.value || typeof node.source.value !== 'string' || node.specifiers.length === 0) {
          return;
        }

        if (options?.ignore?.some(pattern => minimatch(node.source.value, pattern))) {
          return;
        }

        const supportedSpecifiers = node.specifiers.filter(isSupportedImportSpecifier);

        if (supportedSpecifiers.length === 0) {
          return;
        }

        const importerFilename = context.filename;
        const barrelFilePath = resolver.resolveImport(importerFilename, node.source.value);

        if (!barrelFilePath) {
          return;
        }

        const barrelAnalysis = resolver.getBarrelAnalysis(barrelFilePath);

        if (!barrelAnalysis) {
          return;
        }

        const matchedSpecifiers: Array<MatchedSpecifier> = [];

        supportedSpecifiers.forEach(specifier => {
          const specifierIsTypeOnly =
            specifier.type === AST_NODE_TYPES.ImportSpecifier ? isTypeOnlyImport(node, specifier) : false;
          const importedName =
            specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier ? 'default' : specifier.imported.name;
          // A plain import may name a type, which TypeScript allows without the `type` modifier.
          const reExportTarget = barrelAnalysis.lookup(importedName, specifierIsTypeOnly ? 'type' : 'value-or-type');

          if (!reExportTarget) {
            return;
          }

          matchedSpecifiers.push({
            preferredSourceSpecifier: resolver.getPreferredSourceSpecifier(
              importerFilename,
              node.source.value,
              reExportTarget,
            ),
            specifier,
            reExportTarget,
          });
        });

        if (matchedSpecifiers.length === 0) {
          return;
        }

        const canAutoFix =
          matchedSpecifiers.every(({ preferredSourceSpecifier }) => preferredSourceSpecifier !== null) &&
          matchedSpecifiers.length === node.specifiers.length &&
          node.specifiers.every(isSupportedImportSpecifier);
        const hasNamespaceTarget = matchedSpecifiers.some(({ reExportTarget }) => reExportTarget.isNamespace);
        const autofix = hasNamespaceTarget
          ? buildNamespaceAutofix(node, matchedSpecifiers)
          : canAutoFix
            ? buildAutofix(sourceCode, node, matchedSpecifiers)
            : null;

        if (autofix) {
          context.report({
            node,
            messageId: 'preferSourceImports',
            data: {
              barrel: node.source.value,
            },
            fix: autofix,
          });

          return;
        }

        matchedSpecifiers.forEach(({ preferredSourceSpecifier, specifier, reExportTarget }) => {
          context.report({
            node: specifier,
            messageId: 'preferSourceImport',
            data: {
              barrel: node.source.value,
              name: specifier.local.name,
              source: preferredSourceSpecifier ?? reExportTarget.sourceSpecifier,
            },
          });
        });
      },
    };
  },
};

export const __private__ = {
  applyAliasTarget,
  buildAliasSpecifier,
  buildAutofix,
  buildNamespaceAutofix,
  collectAllExportedBindings,
  collectBarrelAnalysis,
  collectExportedBindings,
  createAnalysisCaches,
  createImportResolver,
  createResolutionCaches,
  createSharedResolutionCaches,
  getManualAliasMappings,
  getTypeScriptModule,
  hasTypeScriptModule,
  getMergeableImportDeclaration,
  getPreferredSourceSpecifier,
  getTsconfigInfo,
  getTsconfigPath,
  isNamedImportSpecifier,
  isSupportedImportSpecifier,
  isRelativePath,
  isTypeOnlyImport,
  matchesAliasPattern,
  normalizeModulePath,
  parseBarrelFile,
  parseExportedBindings,
  parseModule,
  resolveImport,
  resolveModuleFile,
  resolveReExportTarget,
  resolveWithManualPaths,
  resolveWithTsconfig,
  reverseResolveManualAlias,
  reverseResolveTsconfigAlias,
  setTypeScriptModuleLoaderForTests,
  shouldReportMissingTypeScript,
  serializeImportBinding,
  serializeImportBindings,
  toRelativeImportSpecifier,
};

export default preferSourceImports;
