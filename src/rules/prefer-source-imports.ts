import fs from 'node:fs';
import path from 'node:path';
import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parser = require('@typescript-eslint/parser');

type MessageIds = 'preferSourceImport' | 'preferSourceImports';

type ReExportTarget = {
  importedName: string;
  sourcePath: string;
  isTypeOnly: boolean;
  fromExportAll: boolean;
};

type NamedImportSpecifier = TSESTree.ImportSpecifier & {
  imported: TSESTree.Identifier;
  local: TSESTree.Identifier;
};

type MatchedSpecifier = {
  specifier: NamedImportSpecifier;
  reExportTarget: ReExportTarget;
};

type BarrelAnalysis = {
  explicitReExports: Map<string, ReExportTarget>;
  exportAllReExports: Map<string, ReExportTarget>;
};

const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;

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

function parseBarrelFile(barrelFilePath: string): BarrelAnalysis | null {
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
      typeof source.value === 'string' &&
      isRelativePath(source.value)
    ) {
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
          sourcePath: source.value,
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
      typeof statement.source.value === 'string' &&
      isRelativePath(statement.source.value)
    ) {
      const resolvedSourceFile = resolveModuleFile(barrelFilePath, statement.source.value);

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
          sourcePath: statement.source.value,
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
  sourcePath: string,
): TSESTree.ImportDeclaration | null {
  if (node.source.value !== sourcePath) {
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

  matchedSpecifiers.forEach(({ specifier, reExportTarget }) => {
    const importBindings = groupedImports.get(reExportTarget.sourcePath) ?? [];
    importBindings.push({
      importedName: reExportTarget.importedName,
      isTypeOnly: reExportTarget.isTypeOnly,
      localName: specifier.local.name,
    });
    groupedImports.set(reExportTarget.sourcePath, importBindings);
  });

  const mergeTargets = new Map<string, TSESTree.ImportDeclaration>();

  for (const sourcePath of groupedImports.keys()) {
    const matchingDeclarations = sourceCode.ast.body.filter(
      statement =>
        statement.type === AST_NODE_TYPES.ImportDeclaration &&
        statement !== currentNode &&
        getMergeableImportDeclaration(statement, sourcePath),
    ) as TSESTree.ImportDeclaration[];

    if (matchingDeclarations.length > 1) {
      return null;
    }

    if (matchingDeclarations.length === 1) {
      mergeTargets.set(sourcePath, matchingDeclarations[0]!);
    }
  }

  return fixer => {
    const fixes: TSESLint.RuleFix[] = [];

    for (const [sourcePath, bindings] of groupedImports.entries()) {
      const mergeTarget = mergeTargets.get(sourcePath);

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
      const mergedImport = `import${allTypeOnly ? ' type' : ''} { ${serializedBindings} } from ${quote}${sourcePath}${quote};`;

      fixes.push(fixer.replaceText(mergeTarget, mergedImport));
      groupedImports.delete(sourcePath);
    }

    const quote = currentNode.source.raw?.startsWith("'") ? "'" : '"';
    const replacement = Array.from(groupedImports.entries())
      .map(([sourcePath, bindings]) => {
        const allTypeOnly = currentNode.importKind === 'type' || bindings.every(binding => binding.isTypeOnly);
        const serializedBindings = serializeImportBindings(bindings, allTypeOnly);

        return `import${allTypeOnly ? ' type' : ''} { ${serializedBindings} } from ${quote}${sourcePath}${quote};`;
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

const preferSourceImports: TSESLint.RuleModule<MessageIds> = {
  defaultOptions: [],
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      url: 'https://github.com/art0rz/eslint-plugin-no-barrel-files',
      description: 'prefer importing from source modules instead of barrel re-exports',
    },
    schema: [],
    messages: {
      preferSourceImport: "Import '{{name}}' directly from '{{source}}' instead of barrel '{{barrel}}'.",
      preferSourceImports: "Import directly from source modules instead of barrel '{{barrel}}'.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const barrelExportCache = new Map<string, BarrelAnalysis | null>();

    function getBarrelAnalysis(barrelFilePath: string): BarrelAnalysis | null {
      if (!barrelExportCache.has(barrelFilePath)) {
        barrelExportCache.set(barrelFilePath, parseBarrelFile(barrelFilePath));
      }

      return barrelExportCache.get(barrelFilePath) ?? null;
    }

    return {
      ImportDeclaration(node) {
        if (
          !node.source.value ||
          typeof node.source.value !== 'string' ||
          !isRelativePath(node.source.value) ||
          node.specifiers.length === 0
        ) {
          return;
        }

        const importerFilename = context.filename;
        const barrelFilePath = resolveModuleFile(importerFilename, node.source.value);

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
            matchedSpecifiers.push({
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

          matchedSpecifiers.push({
            specifier,
            reExportTarget: exportAllReExport,
          });
        });

        if (matchedSpecifiers.length === 0) {
          return;
        }

        const canAutoFix =
          matchedSpecifiers.every(({ reExportTarget }) => !reExportTarget.fromExportAll) &&
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
              source: reExportTarget.sourcePath,
            },
          });
        });
      },
    };
  },
};

export default preferSourceImports;
