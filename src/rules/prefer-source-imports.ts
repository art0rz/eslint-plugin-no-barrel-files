import fs from 'node:fs';
import path from 'node:path';
import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const typescript = require('typescript');

type MessageIds = 'preferSourceImport' | 'preferSourceImports';
type Options = [
  {
    fixStyle?: 'auto' | 'preserve-alias' | 'relative';
    paths?: Record<string, string | string[]>;
    tsconfig?: boolean | string;
  }?,
];

type ReExportTarget = {
  importedName: string;
  resolvedFilePath: string;
  sourceSpecifier: string;
  isTypeOnly: boolean;
  fromExportAll: boolean;
};

type NamedImportSpecifier = TSESTree.ImportSpecifier & {
  imported: TSESTree.Identifier;
  local: TSESTree.Identifier;
};

type MatchedSpecifier = {
  preferredSourceSpecifier: string;
  specifier: NamedImportSpecifier;
  reExportTarget: ReExportTarget;
};

type BarrelAnalysis = {
  explicitReExports: Map<string, ReExportTarget>;
  exportAllReExports: Map<string, ReExportTarget>;
};

const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;

type TsconfigInfo = {
  compilerOptions: Record<string, unknown>;
  configFilePath: string;
};

type ManualAliasMapping = {
  pattern: string;
  target: string;
};

function isRelativePath(value: string): boolean {
  return value.startsWith('.');
}

function resolveModuleFile(importerFilename: string, specifier: string): string | null {
  const resolvedBase = path.resolve(path.dirname(importerFilename), specifier);
  const candidatePaths = [
    resolvedBase,
    ...SOURCE_FILE_EXTENSIONS.map(extension => `${resolvedBase}${extension}`),
    ...SOURCE_FILE_EXTENSIONS.map(extension => path.join(resolvedBase, `index${extension}`)),
  ];

  return (
    candidatePaths.find(candidatePath => fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) ?? null
  );
}

function normalizeModulePath(filePath: string): string {
  const normalizedPath = filePath.split(path.sep).join('/');

  return normalizedPath.replace(/\/index(?=(\.[^./]+)?$)/, '').replace(/\.[^./]+$/, '');
}

function toRelativeImportSpecifier(importerFilename: string, resolvedFilePath: string): string {
  const relativePath = path.relative(path.dirname(importerFilename), resolvedFilePath);
  const normalizedPath = normalizeModulePath(relativePath);

  return normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`;
}

function matchesAliasPattern(specifier: string, pattern: string): string | null {
  if (!pattern.includes('*')) {
    return specifier === pattern ? '' : null;
  }

  const [rawPrefix = '', rawSuffix = ''] = pattern.split('*');
  const prefix = rawPrefix;
  const suffix = rawSuffix;

  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyAliasTarget(target: string, wildcardValue: string): string {
  return target.includes('*') ? target.replace('*', wildcardValue) : target;
}

function buildAliasSpecifier(pattern: string, wildcardValue: string): string {
  return pattern.includes('*') ? pattern.replace('*', wildcardValue) : pattern;
}

function parseModule(filePath: string): TSESTree.Program | null {
  let sourceText: string;

  try {
    sourceText = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  try {
    return parser.parse(sourceText, {
      filePath,
      ecmaVersion: 'latest',
      sourceType: 'module',
      range: false,
      loc: false,
      comment: false,
      tokens: false,
    }) as TSESTree.Program;
  } catch {
    return null;
  }
}

function parseExportedNames(filePath: string): Set<string> {
  const program = parseModule(filePath);

  if (!program) {
    return new Set();
  }

  const exportedNames = new Set<string>();

  program.body.forEach(statement => {
    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      if (statement.declaration) {
        switch (statement.declaration.type) {
          case AST_NODE_TYPES.VariableDeclaration:
            statement.declaration.declarations.forEach(declaration => {
              if (declaration.id.type === AST_NODE_TYPES.Identifier) {
                exportedNames.add(declaration.id.name);
              }
            });
            break;
          case AST_NODE_TYPES.FunctionDeclaration:
          case AST_NODE_TYPES.ClassDeclaration:
          case AST_NODE_TYPES.TSEnumDeclaration:
          case AST_NODE_TYPES.TSInterfaceDeclaration:
          case AST_NODE_TYPES.TSTypeAliasDeclaration:
            if (statement.declaration.id) {
              exportedNames.add(statement.declaration.id.name);
            }
            break;
        }
      }

      statement.specifiers.forEach(specifier => {
        if (specifier.type !== AST_NODE_TYPES.ExportSpecifier) {
          return;
        }

        if (specifier.exported.type === AST_NODE_TYPES.Identifier) {
          exportedNames.add(specifier.exported.name);
        }
      });
    }
  });

  return exportedNames;
}

function parseBarrelFile(
  barrelFilePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
): BarrelAnalysis | null {
  const program = parseModule(barrelFilePath);

  if (!program) {
    return null;
  }

  const explicitReExports = new Map<string, ReExportTarget>();
  const exportAllReExports = new Map<string, ReExportTarget>();

  program.body.forEach(statement => {
    const source = statement.type === AST_NODE_TYPES.ExportNamedDeclaration ? statement.source : null;

    if (
      statement.type === AST_NODE_TYPES.ExportNamedDeclaration &&
      source?.type === AST_NODE_TYPES.Literal &&
      typeof source.value === 'string'
    ) {
      const resolvedSourceFile = resolveImport(barrelFilePath, source.value);

      if (!resolvedSourceFile) {
        return;
      }

      statement.specifiers.forEach(specifier => {
        if (
          specifier.type !== AST_NODE_TYPES.ExportSpecifier ||
          specifier.local.type !== AST_NODE_TYPES.Identifier ||
          specifier.exported.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        explicitReExports.set(specifier.exported.name, {
          importedName: specifier.local.name,
          resolvedFilePath: resolvedSourceFile,
          sourceSpecifier: source.value,
          isTypeOnly: statement.exportKind === 'type',
          fromExportAll: false,
        });
      });
    }

    if (
      statement.type === AST_NODE_TYPES.ExportAllDeclaration &&
      !statement.exported &&
      statement.exportKind !== 'type' &&
      statement.source !== null &&
      statement.source.type === AST_NODE_TYPES.Literal &&
      typeof statement.source.value === 'string'
    ) {
      const resolvedSourceFile = resolveImport(barrelFilePath, statement.source.value);

      if (!resolvedSourceFile) {
        return;
      }

      const exportedNames = parseExportedNames(resolvedSourceFile);

      exportedNames.forEach(exportedName => {
        if (explicitReExports.has(exportedName) || exportAllReExports.has(exportedName)) {
          return;
        }

        exportAllReExports.set(exportedName, {
          importedName: exportedName,
          resolvedFilePath: resolvedSourceFile,
          sourceSpecifier: statement.source.value,
          isTypeOnly: false,
          fromExportAll: true,
        });
      });
    }
  });

  if (explicitReExports.size === 0 && exportAllReExports.size === 0) {
    return null;
  }

  return {
    explicitReExports,
    exportAllReExports,
  };
}

function isNamedImportSpecifier(specifier: TSESTree.ImportClause): specifier is NamedImportSpecifier {
  return (
    specifier.type === AST_NODE_TYPES.ImportSpecifier &&
    specifier.imported.type === AST_NODE_TYPES.Identifier &&
    specifier.local.type === AST_NODE_TYPES.Identifier
  );
}

function isTypeOnlyImport(
  declaration: TSESTree.ImportDeclaration,
  specifier: TSESTree.ImportSpecifier | null = null,
): boolean {
  return declaration.importKind === 'type' || specifier?.importKind === 'type';
}

function serializeImportBinding(importedName: string, localName: string, isTypeOnly: boolean): string {
  if (importedName === 'default') {
    return `${isTypeOnly ? 'type ' : ''}default as ${localName}`;
  }

  const binding = importedName === localName ? importedName : `${importedName} as ${localName}`;

  return isTypeOnly ? `type ${binding}` : binding;
}

function serializeImportBindings(
  bindings: Array<{ importedName: string; isTypeOnly: boolean; localName: string }>,
  allTypeOnly: boolean,
): string {
  return bindings
    .map(binding =>
      serializeImportBinding(binding.importedName, binding.localName, allTypeOnly ? false : binding.isTypeOnly),
    )
    .join(', ');
}

function getMergeableImportDeclaration(
  node: TSESTree.ImportDeclaration,
  sourceSpecifier: string,
): TSESTree.ImportDeclaration | null {
  if (node.source.value !== sourceSpecifier) {
    return null;
  }

  if (
    node.specifiers.some(
      specifier =>
        specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
        specifier.importKind === 'type' ||
        specifier.imported.type !== AST_NODE_TYPES.Identifier ||
        specifier.local.type !== AST_NODE_TYPES.Identifier,
    )
  ) {
    return null;
  }

  return node;
}

function buildAutofix(
  sourceCode: TSESLint.SourceCode,
  currentNode: TSESTree.ImportDeclaration,
  matchedSpecifiers: MatchedSpecifier[],
): TSESLint.ReportFixFunction | null {
  const groupedImports = new Map<string, Array<{ importedName: string; isTypeOnly: boolean; localName: string }>>();

  matchedSpecifiers.forEach(({ preferredSourceSpecifier, specifier, reExportTarget }) => {
    const importBindings = groupedImports.get(preferredSourceSpecifier) ?? [];
    importBindings.push({
      importedName: reExportTarget.importedName,
      isTypeOnly: reExportTarget.isTypeOnly,
      localName: specifier.local.name,
    });
    groupedImports.set(preferredSourceSpecifier, importBindings);
  });

  const mergeTargets = new Map<string, TSESTree.ImportDeclaration>();

  for (const sourceSpecifier of groupedImports.keys()) {
    const matchingDeclarations = sourceCode.ast.body.filter(
      statement =>
        statement.type === AST_NODE_TYPES.ImportDeclaration &&
        statement !== currentNode &&
        getMergeableImportDeclaration(statement, sourceSpecifier),
    ) as TSESTree.ImportDeclaration[];

    if (matchingDeclarations.length > 1) {
      return null;
    }

    if (matchingDeclarations.length === 1) {
      mergeTargets.set(sourceSpecifier, matchingDeclarations[0]!);
    }
  }

  return fixer => {
    const fixes: TSESLint.RuleFix[] = [];

    for (const [sourceSpecifier, bindings] of groupedImports.entries()) {
      const mergeTarget = mergeTargets.get(sourceSpecifier);

      if (!mergeTarget) {
        continue;
      }

      const existingBindings = new Map<string, string>();
      const existingTypeOnlyByLocalName = new Map<string, boolean>();
      let hasConflict = false;

      mergeTarget.specifiers.forEach(specifier => {
        if (
          specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
          specifier.imported.type !== AST_NODE_TYPES.Identifier ||
          specifier.local.type !== AST_NODE_TYPES.Identifier
        ) {
          hasConflict = true;
          return;
        }

        const localName = specifier.local.name;
        const importedName = specifier.imported.name;
        const typeOnly = isTypeOnlyImport(mergeTarget, specifier);
        const currentImportedName = existingBindings.get(localName);
        const currentTypeOnly = existingTypeOnlyByLocalName.get(localName);

        if (currentImportedName && (currentImportedName !== importedName || currentTypeOnly !== typeOnly)) {
          hasConflict = true;
          return;
        }

        existingBindings.set(localName, importedName);
        existingTypeOnlyByLocalName.set(localName, typeOnly);
      });

      if (hasConflict) {
        return null;
      }

      bindings.forEach(binding => {
        const currentImportedName = existingBindings.get(binding.localName);
        const currentTypeOnly = existingTypeOnlyByLocalName.get(binding.localName);

        if (
          currentImportedName &&
          (currentImportedName !== binding.importedName || currentTypeOnly !== binding.isTypeOnly)
        ) {
          hasConflict = true;
          return;
        }

        existingBindings.set(binding.localName, binding.importedName);
        existingTypeOnlyByLocalName.set(binding.localName, binding.isTypeOnly);
      });

      if (hasConflict) {
        return null;
      }

      const quote = mergeTarget.source.raw?.startsWith("'") ? "'" : '"';
      const allTypeOnly =
        mergeTarget.importKind === 'type' || Array.from(existingTypeOnlyByLocalName.values()).every(Boolean);
      const serializedBindings = serializeImportBindings(
        Array.from(existingBindings.entries()).map(([localName, importedName]) => ({
          importedName,
          isTypeOnly: existingTypeOnlyByLocalName.get(localName) ?? false,
          localName,
        })),
        allTypeOnly,
      );
      const mergedImport = `import${allTypeOnly ? ' type' : ''} { ${serializedBindings} } from ${quote}${sourceSpecifier}${quote};`;

      fixes.push(fixer.replaceText(mergeTarget, mergedImport));
      groupedImports.delete(sourceSpecifier);
    }

    const quote = currentNode.source.raw?.startsWith("'") ? "'" : '"';
    const replacement = Array.from(groupedImports.entries())
      .map(([sourceSpecifier, bindings]) => {
        const allTypeOnly = currentNode.importKind === 'type' || bindings.every(binding => binding.isTypeOnly);
        const serializedBindings = serializeImportBindings(bindings, allTypeOnly);

        return `import${allTypeOnly ? ' type' : ''} { ${serializedBindings} } from ${quote}${sourceSpecifier}${quote};`;
      })
      .join('\n');

    if (replacement) {
      fixes.push(fixer.replaceText(currentNode, replacement));
    } else {
      const [start, end] = currentNode.range;
      const adjustedEnd = sourceCode.text.slice(end, end + 1) === '\n' ? end + 1 : end;
      fixes.push(fixer.removeRange([start, adjustedEnd]));
    }

    return fixes;
  };
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
    const tsconfigCache = new Map<string, TsconfigInfo | null>();
    const fixStyle = options?.fixStyle ?? 'auto';

    function getTsconfigPath(importerFilename: string): string | null {
      if (options?.tsconfig === false) {
        return null;
      }

      if (typeof options?.tsconfig === 'string') {
        return path.isAbsolute(options.tsconfig) ? options.tsconfig : path.resolve(process.cwd(), options.tsconfig);
      }

      return typescript.findConfigFile(path.dirname(importerFilename), typescript.sys.fileExists, 'tsconfig.json');
    }

    function getTsconfigInfo(importerFilename: string): TsconfigInfo | null {
      const tsconfigPath = getTsconfigPath(importerFilename);

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

    function resolveWithManualPaths(importerFilename: string, specifier: string): string | null {
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
          const candidateBasePath = path.resolve(process.cwd(), candidateSpecifier);
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

    function getManualAliasMappings(): Array<ManualAliasMapping> {
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

    function resolveWithTsconfig(importerFilename: string, specifier: string): string | null {
      const tsconfigInfo = getTsconfigInfo(importerFilename);

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

    function resolveImport(importerFilename: string, specifier: string): string | null {
      if (isRelativePath(specifier)) {
        return resolveModuleFile(importerFilename, specifier);
      }

      return resolveWithManualPaths(importerFilename, specifier) ?? resolveWithTsconfig(importerFilename, specifier);
    }

    function reverseResolveManualAlias(resolvedFilePath: string): string | null {
      const candidateAliases = getManualAliasMappings()
        .map(mapping => {
          if (mapping.target.includes('*')) {
            const [rawPrefix = '', rawSuffix = ''] = mapping.target.split('*');
            const normalizedResolvedFilePath = normalizeModulePath(resolvedFilePath);
            const normalizedPrefix = normalizeModulePath(path.resolve(process.cwd(), rawPrefix));
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

          const targetFilePath = resolveModuleFile(process.cwd(), path.resolve(process.cwd(), mapping.target));

          return targetFilePath === resolvedFilePath ? mapping.pattern : null;
        })
        .filter((value): value is string => value !== null);

      return candidateAliases.length === 1 ? (candidateAliases[0] ?? null) : null;
    }

    function reverseResolveTsconfigAlias(importerFilename: string, resolvedFilePath: string): string | null {
      const tsconfigInfo = getTsconfigInfo(importerFilename);

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

      return candidateAliases.length === 1 ? (candidateAliases[0] ?? null) : null;
    }

    function getPreferredSourceSpecifier(
      importerFilename: string,
      originalImportSpecifier: string,
      reExportTarget: ReExportTarget,
    ): string | null {
      if (fixStyle === 'relative') {
        return toRelativeImportSpecifier(importerFilename, reExportTarget.resolvedFilePath);
      }

      if (!isRelativePath(reExportTarget.sourceSpecifier)) {
        return reExportTarget.sourceSpecifier;
      }

      const aliasCandidates = [
        reverseResolveManualAlias(reExportTarget.resolvedFilePath),
        reverseResolveTsconfigAlias(importerFilename, reExportTarget.resolvedFilePath),
      ].filter((value): value is string => value !== null);
      const uniqueAliasCandidates = Array.from(new Set(aliasCandidates));

      if (fixStyle === 'preserve-alias') {
        return uniqueAliasCandidates.length === 1 ? (uniqueAliasCandidates[0] ?? null) : null;
      }

      if (!isRelativePath(originalImportSpecifier) && uniqueAliasCandidates.length === 1) {
        return uniqueAliasCandidates[0] ?? null;
      }

      return toRelativeImportSpecifier(importerFilename, reExportTarget.resolvedFilePath);
    }

    function getBarrelAnalysis(barrelFilePath: string): BarrelAnalysis | null {
      if (!barrelExportCache.has(barrelFilePath)) {
        barrelExportCache.set(barrelFilePath, parseBarrelFile(barrelFilePath, resolveImport));
      }

      return barrelExportCache.get(barrelFilePath) ?? null;
    }

    return {
      ImportDeclaration(node) {
        if (!node.source.value || typeof node.source.value !== 'string' || node.specifiers.length === 0) {
          return;
        }

        const importerFilename = context.filename;
        const barrelFilePath = resolveImport(importerFilename, node.source.value);

        if (!barrelFilePath) {
          return;
        }

        const barrelAnalysis = getBarrelAnalysis(barrelFilePath);

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
          const explicitReExport = barrelAnalysis.explicitReExports.get(specifier.imported.name);

          if (explicitReExport && explicitReExport.isTypeOnly === specifierIsTypeOnly) {
            const preferredSourceSpecifier = getPreferredSourceSpecifier(
              importerFilename,
              node.source.value,
              explicitReExport,
            );

            if (!preferredSourceSpecifier) {
              return;
            }

            matchedSpecifiers.push({
              preferredSourceSpecifier,
              specifier,
              reExportTarget: explicitReExport,
            });
            return;
          }

          if (specifierIsTypeOnly) {
            return;
          }

          const exportAllReExport = barrelAnalysis.exportAllReExports.get(specifier.imported.name);

          if (!exportAllReExport) {
            return;
          }

          const preferredSourceSpecifier = getPreferredSourceSpecifier(
            importerFilename,
            node.source.value,
            exportAllReExport,
          );

          if (!preferredSourceSpecifier) {
            return;
          }

          matchedSpecifiers.push({
            preferredSourceSpecifier,
            specifier,
            reExportTarget: exportAllReExport,
          });
        });

        if (matchedSpecifiers.length === 0) {
          return;
        }

        const canAutoFix =
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
                getPreferredSourceSpecifier(importerFilename, node.source.value, reExportTarget) ??
                reExportTarget.sourceSpecifier,
            },
          });
        });
      },
    };
  },
};

export default preferSourceImports;
