/// <reference types="node" />
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
  preferredSourceSpecifier: string | null;
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

function getReExportKey(exportedName: string, isTypeOnly: boolean): string {
  return `${isTypeOnly ? 'type' : 'value'}:${exportedName}`;
}

function getReExportMeta(reExportKey: string): { exportedName: string; isTypeOnly: boolean } {
  if (reExportKey.startsWith('type:')) {
    return {
      exportedName: reExportKey.slice(5),
      isTypeOnly: true,
    };
  }

  return {
    exportedName: reExportKey.slice(6),
    isTypeOnly: false,
  };
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

function collectExportedBindings(program: TSESTree.Program): Set<string> {
  const exportedBindings = new Set<string>();

  function addExportedBinding(exportedName: string, isTypeOnly: boolean): void {
    exportedBindings.add(getReExportKey(exportedName, isTypeOnly));
  }

  program.body.forEach(statement => {
    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      if (statement.declaration) {
        switch (statement.declaration.type) {
          case AST_NODE_TYPES.VariableDeclaration:
            statement.declaration.declarations.forEach(declaration => {
              if (declaration.id.type === AST_NODE_TYPES.Identifier) {
                addExportedBinding(declaration.id.name, false);
              }
            });
            break;
          case AST_NODE_TYPES.FunctionDeclaration:
            if (statement.declaration.id) {
              addExportedBinding(statement.declaration.id.name, false);
            }
            break;
          case AST_NODE_TYPES.ClassDeclaration:
          case AST_NODE_TYPES.TSEnumDeclaration:
            if (statement.declaration.id) {
              addExportedBinding(statement.declaration.id.name, false);
              addExportedBinding(statement.declaration.id.name, true);
            }
            break;
          case AST_NODE_TYPES.TSInterfaceDeclaration:
          case AST_NODE_TYPES.TSTypeAliasDeclaration:
            if (statement.declaration.id) {
              addExportedBinding(statement.declaration.id.name, true);
            }
            break;
        }
      }

      statement.specifiers.forEach(specifier => {
        if (specifier.type !== AST_NODE_TYPES.ExportSpecifier) {
          return;
        }

        if (specifier.exported.type === AST_NODE_TYPES.Identifier) {
          addExportedBinding(
            specifier.exported.name,
            statement.exportKind === 'type' || specifier.exportKind === 'type',
          );
        }
      });
    }
  });

  return exportedBindings;
}

function parseExportedBindings(filePath: string): Set<string> {
  const program = parseModule(filePath);

  if (!program) {
    return new Set();
  }

  return collectExportedBindings(program);
}

function collectAllExportedBindings(
  filePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  visitedFiles: Set<string> = new Set(),
): Set<string> {
  if (visitedFiles.has(filePath)) {
    return new Set();
  }

  const program = parseModule(filePath);

  if (!program) {
    return new Set();
  }

  const nextVisitedFiles = new Set(visitedFiles);
  nextVisitedFiles.add(filePath);

  const exportedBindings = collectExportedBindings(program);

  program.body.forEach(statement => {
    if (
      statement.type !== AST_NODE_TYPES.ExportAllDeclaration ||
      statement.exported ||
      statement.source.type !== AST_NODE_TYPES.Literal ||
      typeof statement.source.value !== 'string'
    ) {
      return;
    }

    const resolvedSourceFile = resolveImport(filePath, statement.source.value);

    if (!resolvedSourceFile) {
      return;
    }

    const nestedBindings = collectAllExportedBindings(resolvedSourceFile, resolveImport, nextVisitedFiles);

    nestedBindings.forEach(reExportKey => {
      const { isTypeOnly } = getReExportMeta(reExportKey);

      if (statement.exportKind === 'type' && !isTypeOnly) {
        return;
      }

      if (exportedBindings.has(reExportKey)) {
        return;
      }

      exportedBindings.add(reExportKey);
    });
  });

  return exportedBindings;
}

function resolveReExportTarget(
  filePath: string,
  exportedName: string,
  isTypeOnly: boolean,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  visitedTargets: Set<string> = new Set(),
): ReExportTarget | null {
  const reExportKey = getReExportKey(exportedName, isTypeOnly);
  const visitedTargetKey = `${filePath}:${reExportKey}`;

  if (visitedTargets.has(visitedTargetKey)) {
    return null;
  }

  const program = parseModule(filePath);

  if (!program) {
    return null;
  }

  const nextVisitedTargets = new Set(visitedTargets);
  nextVisitedTargets.add(visitedTargetKey);

  const barrelAnalysis = collectBarrelAnalysis(program, filePath, resolveImport, nextVisitedTargets);

  if (!barrelAnalysis) {
    return null;
  }

  return (
    barrelAnalysis.explicitReExports.get(reExportKey) ?? barrelAnalysis.exportAllReExports.get(reExportKey) ?? null
  );
}

function collectBarrelAnalysis(
  program: TSESTree.Program,
  barrelFilePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  visitedTargets: Set<string> = new Set(),
): BarrelAnalysis | null {
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

        const specifierIsTypeOnly = statement.exportKind === 'type' || specifier.exportKind === 'type';
        const resolvedTarget =
          resolveReExportTarget(
            resolvedSourceFile,
            specifier.local.name,
            specifierIsTypeOnly,
            resolveImport,
            visitedTargets,
          ) ??
          ({
            importedName: specifier.local.name,
            resolvedFilePath: resolvedSourceFile,
            sourceSpecifier: source.value,
            isTypeOnly: specifierIsTypeOnly,
            fromExportAll: false,
          } satisfies ReExportTarget);

        if (resolvedTarget.resolvedFilePath === barrelFilePath) {
          return;
        }

        explicitReExports.set(getReExportKey(specifier.exported.name, specifierIsTypeOnly), {
          importedName: resolvedTarget.importedName,
          resolvedFilePath: resolvedTarget.resolvedFilePath,
          sourceSpecifier: resolvedTarget.sourceSpecifier,
          isTypeOnly: specifierIsTypeOnly,
          fromExportAll: false,
        });
      });
    }

    if (
      statement.type === AST_NODE_TYPES.ExportAllDeclaration &&
      !statement.exported &&
      statement.source !== null &&
      statement.source.type === AST_NODE_TYPES.Literal &&
      typeof statement.source.value === 'string'
    ) {
      const resolvedSourceFile = resolveImport(barrelFilePath, statement.source.value);

      if (!resolvedSourceFile) {
        return;
      }

      const exportedBindings = collectAllExportedBindings(resolvedSourceFile, resolveImport, new Set([barrelFilePath]));

      exportedBindings.forEach(reExportKey => {
        const { exportedName, isTypeOnly } = getReExportMeta(reExportKey);

        if (statement.exportKind === 'type' && !isTypeOnly) {
          return;
        }

        if (explicitReExports.has(reExportKey) || exportAllReExports.has(reExportKey)) {
          return;
        }

        const resolvedTarget =
          resolveReExportTarget(resolvedSourceFile, exportedName, isTypeOnly, resolveImport, visitedTargets) ??
          ({
            importedName: exportedName,
            resolvedFilePath: resolvedSourceFile,
            sourceSpecifier: statement.source.value,
            isTypeOnly,
            fromExportAll: true,
          } satisfies ReExportTarget);

        if (resolvedTarget.resolvedFilePath === barrelFilePath) {
          return;
        }

        exportAllReExports.set(reExportKey, {
          importedName: resolvedTarget.importedName,
          resolvedFilePath: resolvedTarget.resolvedFilePath,
          sourceSpecifier: resolvedTarget.sourceSpecifier,
          isTypeOnly,
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

function parseBarrelFile(
  barrelFilePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
): BarrelAnalysis | null {
  const program = parseModule(barrelFilePath);

  if (!program) {
    return null;
  }

  return collectBarrelAnalysis(program, barrelFilePath, resolveImport);
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
    if (!preferredSourceSpecifier) {
      return;
    }

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
        const importSpecifier = specifier as NamedImportSpecifier;
        const localName = importSpecifier.local.name;
        const importedName = importSpecifier.imported.name;
        const typeOnly = isTypeOnlyImport(mergeTarget, importSpecifier);
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
      const allTypeOnly = Array.from(existingTypeOnlyByLocalName.values()).every(Boolean);
      const serializedBindings = serializeImportBindings(
        Array.from(existingBindings.entries()).map(([localName, importedName]) => ({
          importedName,
          isTypeOnly: existingTypeOnlyByLocalName.get(localName)!,
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
        const allTypeOnly = bindings.every(binding => binding.isTypeOnly);
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
  if (isRelativePath(specifier)) {
    return resolveModuleFile(importerFilename, specifier);
  }

  return (
    resolveWithManualPaths(options, importerFilename, specifier, cwd) ??
    resolveWithTsconfig(options, importerFilename, specifier, tsconfigCache, cwd)
  );
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
  if (!barrelExportCache.has(barrelFilePath)) {
    barrelExportCache.set(
      barrelFilePath,
      parseBarrelFile(barrelFilePath, (importerFilename, specifier) =>
        resolveImport(options, tsconfigCache, importerFilename, specifier, cwd),
      ),
    );
  }

  return barrelExportCache.get(barrelFilePath) ?? null;
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
