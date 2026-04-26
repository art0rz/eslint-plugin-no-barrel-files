import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
import {
  createAnalysisCaches,
  collectAllExportedBindings,
  collectBarrelAnalysis,
  collectExportedBindings,
  getReExportKey,
  getReExportMeta,
  parseBarrelFile,
  parseExportedBindings,
  parseModule,
  resolveReExportTarget,
} from './prefer-source-imports/analysis';
import {
  buildAutofix,
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
  createResolutionCaches,
  getBarrelAnalysis,
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
  BarrelAnalysis,
  MatchedSpecifier,
  MessageIds,
  NamedImportSpecifier,
  Options,
} from './prefer-source-imports/types';

function isNamedImportSpecifier(specifier: TSESTree.ImportClause): specifier is NamedImportSpecifier {
  return (
    specifier.type === AST_NODE_TYPES.ImportSpecifier &&
    specifier.imported.type === AST_NODE_TYPES.Identifier &&
    specifier.local.type === AST_NODE_TYPES.Identifier
  );
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
    const barrelExportCache = new Map<string, BarrelAnalysis | null>();
    const analysisCaches = createAnalysisCaches();
    const resolutionCaches = createResolutionCaches();
    const cwd = process.cwd();
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

        const importerFilename = context.filename;
        const barrelFilePath = resolveImport(options, resolutionCaches, importerFilename, node.source.value, cwd);

        if (!barrelFilePath) {
          return;
        }

        const barrelAnalysis = getBarrelAnalysis(
          options,
          barrelFilePath,
          barrelExportCache,
          resolutionCaches,
          analysisCaches,
          cwd,
        );

        if (!barrelAnalysis) {
          return;
        }

        const namedSpecifiers = node.specifiers.filter(isNamedImportSpecifier);

        if (namedSpecifiers.length === 0) {
          return;
        }

        const matchedSpecifiers: Array<MatchedSpecifier> = [];

        namedSpecifiers.forEach(specifier => {
          const specifierIsTypeOnly = isTypeOnlyImport(node, specifier);
          const reExportKey = getReExportKey(specifier.imported.name, specifierIsTypeOnly);
          const explicitReExport = barrelAnalysis.explicitReExports.get(reExportKey);

          if (explicitReExport) {
            matchedSpecifiers.push({
              preferredSourceSpecifier: getPreferredSourceSpecifier(
                options,
                importerFilename,
                node.source.value,
                explicitReExport,
                resolutionCaches.tsconfigInfo,
                cwd,
              ),
              specifier,
              reExportTarget: explicitReExport,
            });
            return;
          }

          const exportAllReExport = barrelAnalysis.exportAllReExports.get(reExportKey);

          if (!exportAllReExport) {
            return;
          }

          matchedSpecifiers.push({
            preferredSourceSpecifier: getPreferredSourceSpecifier(
              options,
              importerFilename,
              node.source.value,
              exportAllReExport,
              resolutionCaches.tsconfigInfo,
              cwd,
            ),
            specifier,
            reExportTarget: exportAllReExport,
          });
        });

        if (matchedSpecifiers.length === 0) {
          return;
        }

        const canAutoFix =
          matchedSpecifiers.every(({ preferredSourceSpecifier }) => preferredSourceSpecifier !== null) &&
          matchedSpecifiers.length === node.specifiers.length &&
          node.specifiers.every(specifier => specifier.type === AST_NODE_TYPES.ImportSpecifier);
        const autofix = canAutoFix ? buildAutofix(sourceCode, node, matchedSpecifiers) : null;

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

        matchedSpecifiers.forEach(({ specifier, reExportTarget }) => {
          context.report({
            node: specifier,
            messageId: 'preferSourceImport',
            data: {
              barrel: node.source.value,
              name: specifier.local.name,
              source:
                getPreferredSourceSpecifier(
                  options,
                  importerFilename,
                  node.source.value,
                  reExportTarget,
                  resolutionCaches.tsconfigInfo,
                  cwd,
                ) ?? reExportTarget.sourceSpecifier,
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
  collectAllExportedBindings,
  collectBarrelAnalysis,
  collectExportedBindings,
  createAnalysisCaches,
  createResolutionCaches,
  getBarrelAnalysis,
  getManualAliasMappings,
  getTypeScriptModule,
  hasTypeScriptModule,
  getMergeableImportDeclaration,
  getPreferredSourceSpecifier,
  getReExportKey,
  getReExportMeta,
  getTsconfigInfo,
  getTsconfigPath,
  isNamedImportSpecifier,
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
