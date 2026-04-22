import fs from 'node:fs';
import path from 'node:path';
import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
import {
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
  getOptionsCacheKey,
  isRelativePath,
  matchesAliasPattern,
  normalizeModulePath,
  resolveModuleFile,
  toRelativeImportSpecifier,
} from './prefer-source-imports/path-utils';
import {
  BarrelAnalysis,
  ManualAliasMapping,
  MatchedSpecifier,
  MessageIds,
  NamedImportSpecifier,
  Options,
  ReExportTarget,
  TsconfigInfo,
} from './prefer-source-imports/types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const typescript = require('typescript');

const importResolutionCache = new Map<string, string | null>();
const barrelAnalysisCache = new Map<string, BarrelAnalysis | null>();
const tsconfigInfoCache = new Map<string, TsconfigInfo | null>();

function isNamedImportSpecifier(specifier: TSESTree.ImportClause): specifier is NamedImportSpecifier {
  return (
    specifier.type === AST_NODE_TYPES.ImportSpecifier &&
    specifier.imported.type === AST_NODE_TYPES.Identifier &&
    specifier.local.type === AST_NODE_TYPES.Identifier
  );
}

function getTsconfigPath(
  options: Options[0] | undefined,
  importerFilename: string,
  cwd: string = process.cwd(),
): string | null {
  if (options?.tsconfig === false) {
    return null;
  }

  if (typeof options?.tsconfig === 'string') {
    return path.isAbsolute(options.tsconfig) ? options.tsconfig : path.resolve(cwd, options.tsconfig);
  }

  return typescript.findConfigFile(path.dirname(importerFilename), typescript.sys.fileExists, 'tsconfig.json');
}

function getTsconfigInfo(
  options: Options[0] | undefined,
  importerFilename: string,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  cwd: string = process.cwd(),
): TsconfigInfo | null {
  const tsconfigPath = getTsconfigPath(options, importerFilename, cwd);

  if (!tsconfigPath) {
    return null;
  }

  if (!tsconfigCache.has(tsconfigPath)) {
    const configFile = typescript.readConfigFile(tsconfigPath, typescript.sys.readFile);

    if (configFile.error) {
      tsconfigCache.set(tsconfigPath, null);
    } else {
      const parsedConfig = typescript.parseJsonConfigFileContent(
        configFile.config,
        typescript.sys,
        path.dirname(tsconfigPath),
        undefined,
        tsconfigPath,
      );

      tsconfigCache.set(tsconfigPath, {
        compilerOptions: parsedConfig.options,
        configFilePath: tsconfigPath,
      });
    }
  }

  return tsconfigCache.get(tsconfigPath) ?? null;
}

function resolveWithManualPaths(
  options: Options[0] | undefined,
  importerFilename: string,
  specifier: string,
  cwd: string = process.cwd(),
): string | null {
  const configuredPaths = options?.paths;

  if (!configuredPaths) {
    return null;
  }

  for (const [pattern, targetValue] of Object.entries(configuredPaths)) {
    const wildcardValue = matchesAliasPattern(specifier, pattern);

    if (wildcardValue === null) {
      continue;
    }

    const targets = Array.isArray(targetValue) ? targetValue : [targetValue];

    for (const target of targets) {
      const candidateSpecifier = applyAliasTarget(target, wildcardValue);
      const candidateBasePath = path.resolve(cwd, candidateSpecifier);
      const resolvedFilePath =
        resolveModuleFile(importerFilename, candidateSpecifier) ??
        resolveModuleFile(importerFilename, candidateBasePath);

      if (resolvedFilePath) {
        return resolvedFilePath;
      }
    }
  }

  return null;
}

function getManualAliasMappings(options: Options[0] | undefined): Array<ManualAliasMapping> {
  const configuredPaths = options?.paths;

  if (!configuredPaths) {
    return [];
  }

  return Object.entries(configuredPaths).flatMap(([pattern, targetValue]) =>
    (Array.isArray(targetValue) ? targetValue : [targetValue]).map(target => ({
      pattern,
      target,
    })),
  );
}

function resolveWithTsconfig(
  options: Options[0] | undefined,
  importerFilename: string,
  specifier: string,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  cwd: string = process.cwd(),
): string | null {
  const tsconfigInfo = getTsconfigInfo(options, importerFilename, tsconfigCache, cwd);

  if (!tsconfigInfo) {
    return null;
  }

  const resolvedModule = typescript.resolveModuleName(
    specifier,
    importerFilename,
    tsconfigInfo.compilerOptions,
    typescript.sys,
  ).resolvedModule;

  if (!resolvedModule || resolvedModule.isExternalLibraryImport) {
    return null;
  }

  return fs.existsSync(resolvedModule.resolvedFileName) ? resolvedModule.resolvedFileName : null;
}

function resolveImport(
  options: Options[0] | undefined,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  importerFilename: string,
  specifier: string,
  cwd: string = process.cwd(),
): string | null {
  const cacheKey = `${getOptionsCacheKey(options, cwd)}\0${importerFilename}\0${specifier}`;
  const cachedResult = importResolutionCache.get(cacheKey);

  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const resolvedFilePath = isRelativePath(specifier)
    ? resolveModuleFile(importerFilename, specifier)
    : (resolveWithManualPaths(options, importerFilename, specifier, cwd) ??
      resolveWithTsconfig(options, importerFilename, specifier, tsconfigCache, cwd));

  importResolutionCache.set(cacheKey, resolvedFilePath);

  return resolvedFilePath;
}

function reverseResolveManualAlias(
  options: Options[0] | undefined,
  resolvedFilePath: string,
  cwd: string = process.cwd(),
): string | null {
  const candidateAliases = getManualAliasMappings(options)
    .map(mapping => {
      if (mapping.target.includes('*')) {
        const [rawPrefix = '', rawSuffix = ''] = mapping.target.split('*');
        const normalizedResolvedFilePath = normalizeModulePath(resolvedFilePath);
        const normalizedPrefix = normalizeModulePath(path.resolve(cwd, rawPrefix));
        const normalizedSuffix = normalizeModulePath(rawSuffix);

        if (
          !normalizedResolvedFilePath.startsWith(normalizedPrefix) ||
          !normalizedResolvedFilePath.endsWith(normalizedSuffix)
        ) {
          return null;
        }

        const wildcardValue = normalizedResolvedFilePath.slice(
          normalizedPrefix.length,
          normalizedResolvedFilePath.length - normalizedSuffix.length,
        );

        return buildAliasSpecifier(mapping.pattern, wildcardValue.replace(/^\//, ''));
      }

      const targetFilePath = resolveModuleFile(cwd, path.resolve(cwd, mapping.target));

      return targetFilePath === resolvedFilePath ? mapping.pattern : null;
    })
    .filter((value): value is string => value !== null);

  return candidateAliases.length === 1 ? candidateAliases[0]! : null;
}

function reverseResolveTsconfigAlias(
  options: Options[0] | undefined,
  importerFilename: string,
  resolvedFilePath: string,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  cwd: string = process.cwd(),
): string | null {
  const tsconfigInfo = getTsconfigInfo(options, importerFilename, tsconfigCache, cwd);

  if (!tsconfigInfo) {
    return null;
  }

  const paths = tsconfigInfo.compilerOptions.paths;

  if (!paths || typeof paths !== 'object') {
    return null;
  }

  const candidateAliases = Object.entries(paths as Record<string, string[]>)
    .flatMap(([pattern, targets]) =>
      targets.map(target => {
        if (target.includes('*')) {
          const [rawPrefix = '', rawSuffix = ''] = target.split('*');
          const normalizedResolvedFilePath = normalizeModulePath(resolvedFilePath);
          const normalizedPrefix = normalizeModulePath(
            path.resolve(path.dirname(tsconfigInfo.configFilePath), rawPrefix),
          );
          const normalizedSuffix = normalizeModulePath(rawSuffix);

          if (
            !normalizedResolvedFilePath.startsWith(normalizedPrefix) ||
            !normalizedResolvedFilePath.endsWith(normalizedSuffix)
          ) {
            return null;
          }

          const wildcardValue = normalizedResolvedFilePath.slice(
            normalizedPrefix.length,
            normalizedResolvedFilePath.length - normalizedSuffix.length,
          );

          return buildAliasSpecifier(pattern, wildcardValue.replace(/^\//, ''));
        }

        const targetFilePath = resolveModuleFile(
          importerFilename,
          path.resolve(path.dirname(tsconfigInfo.configFilePath), target),
        );

        return targetFilePath === resolvedFilePath ? pattern : null;
      }),
    )
    .filter((value): value is string => value !== null);

  return candidateAliases.length === 1 ? candidateAliases[0]! : null;
}

function getPreferredSourceSpecifier(
  options: Options[0] | undefined,
  importerFilename: string,
  originalImportSpecifier: string,
  reExportTarget: ReExportTarget,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  cwd: string = process.cwd(),
): string | null {
  const fixStyle = options?.fixStyle ?? 'auto';

  if (fixStyle === 'relative') {
    return toRelativeImportSpecifier(importerFilename, reExportTarget.resolvedFilePath);
  }

  if (!isRelativePath(reExportTarget.sourceSpecifier)) {
    return reExportTarget.sourceSpecifier;
  }

  const aliasCandidates = [
    reverseResolveManualAlias(options, reExportTarget.resolvedFilePath, cwd),
    reverseResolveTsconfigAlias(options, importerFilename, reExportTarget.resolvedFilePath, tsconfigCache, cwd),
  ].filter((value): value is string => value !== null);
  const uniqueAliasCandidates = Array.from(new Set(aliasCandidates));

  if (fixStyle === 'preserve-alias') {
    return uniqueAliasCandidates.length === 1 ? uniqueAliasCandidates[0]! : null;
  }

  if (!isRelativePath(originalImportSpecifier) && uniqueAliasCandidates.length === 1) {
    return uniqueAliasCandidates[0]!;
  }

  return toRelativeImportSpecifier(importerFilename, reExportTarget.resolvedFilePath);
}

function getBarrelAnalysis(
  options: Options[0] | undefined,
  barrelFilePath: string,
  barrelExportCache: Map<string, BarrelAnalysis | null>,
  tsconfigCache: Map<string, TsconfigInfo | null>,
  cwd: string = process.cwd(),
): BarrelAnalysis | null {
  const cacheKey = `${getOptionsCacheKey(options, cwd)}\0${barrelFilePath}`;
  const cachedAnalysis = barrelExportCache.get(cacheKey);

  if (cachedAnalysis !== undefined) {
    return cachedAnalysis;
  }

  let barrelAnalysis = barrelAnalysisCache.get(cacheKey);

  if (!barrelAnalysisCache.has(cacheKey)) {
    barrelAnalysis = parseBarrelFile(barrelFilePath, (importerFilename, specifier) =>
      resolveImport(options, tsconfigCache, importerFilename, specifier, cwd),
    );
    barrelAnalysisCache.set(cacheKey, barrelAnalysis);
  }

  barrelExportCache.set(cacheKey, barrelAnalysis ?? null);

  return barrelAnalysis ?? null;
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
      preferSourceImport: "Import '{{name}}' directly from '{{source}}' instead of barrel '{{barrel}}'.",
      preferSourceImports: "Import directly from source modules instead of barrel '{{barrel}}'.",
    },
  },
  create(context) {
    const [options] = context.options;
    const sourceCode = context.sourceCode;
    const barrelExportCache = new Map<string, BarrelAnalysis | null>();
    const tsconfigCache = tsconfigInfoCache;
    const cwd = process.cwd();

    return {
      ImportDeclaration(node) {
        if (!node.source.value || typeof node.source.value !== 'string' || node.specifiers.length === 0) {
          return;
        }

        const importerFilename = context.filename;
        const barrelFilePath = resolveImport(options, tsconfigCache, importerFilename, node.source.value, cwd);

        if (!barrelFilePath) {
          return;
        }

        const barrelAnalysis = getBarrelAnalysis(options, barrelFilePath, barrelExportCache, tsconfigCache, cwd);

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
                tsconfigCache,
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
              tsconfigCache,
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
                  tsconfigCache,
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
  getBarrelAnalysis,
  getManualAliasMappings,
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
  serializeImportBinding,
  serializeImportBindings,
  toRelativeImportSpecifier,
};

export default preferSourceImports;
