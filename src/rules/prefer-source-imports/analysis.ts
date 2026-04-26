import fs from 'node:fs';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';
import { AnalysisCaches, BarrelAnalysis, ReExportTarget } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const parser = require('@typescript-eslint/parser');

export function createAnalysisCaches(): AnalysisCaches {
  return {
    exportedBindings: new Map<string, Set<string>>(),
    parsedModules: new Map<string, TSESTree.Program | null>(),
  };
}

export function getReExportKey(exportedName: string, isTypeOnly: boolean): string {
  return `${isTypeOnly ? 'type' : 'value'}:${exportedName}`;
}

export function getReExportMeta(reExportKey: string): { exportedName: string; isTypeOnly: boolean } {
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

export function parseModule(
  filePath: string,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
): TSESTree.Program | null {
  const cachedProgram = analysisCaches.parsedModules.get(filePath);

  if (cachedProgram !== undefined) {
    return cachedProgram;
  }

  let sourceText: string;

  try {
    sourceText = fs.readFileSync(filePath, 'utf8');
  } catch {
    analysisCaches.parsedModules.set(filePath, null);
    return null;
  }

  try {
    const program = parser.parse(sourceText, {
      filePath,
      ecmaVersion: 'latest',
      sourceType: 'module',
      range: false,
      loc: false,
      comment: false,
      tokens: false,
    }) as TSESTree.Program;

    analysisCaches.parsedModules.set(filePath, program);

    return program;
  } catch {
    analysisCaches.parsedModules.set(filePath, null);
    return null;
  }
}

export function collectExportedBindings(program: TSESTree.Program): Set<string> {
  const exportedBindings = new Set<string>();

  function addExportedBinding(exportedName: string, isTypeOnly: boolean): void {
    exportedBindings.add(getReExportKey(exportedName, isTypeOnly));
  }

  function collectBindingNames(
    name:
      | TSESTree.ArrayPattern
      | TSESTree.AssignmentPattern
      | TSESTree.Identifier
      | TSESTree.ObjectPattern
      | TSESTree.RestElement,
  ): string[] {
    switch (name.type) {
      case AST_NODE_TYPES.Identifier:
        return [name.name];
      case AST_NODE_TYPES.ObjectPattern:
        return name.properties.flatMap(property => {
          if (property.type === AST_NODE_TYPES.Property) {
            if (
              property.value.type === AST_NODE_TYPES.Identifier ||
              property.value.type === AST_NODE_TYPES.ObjectPattern ||
              property.value.type === AST_NODE_TYPES.ArrayPattern ||
              property.value.type === AST_NODE_TYPES.AssignmentPattern
            ) {
              return collectBindingNames(property.value);
            }

            return [];
          }

          if (property.type === AST_NODE_TYPES.RestElement) {
            if (
              property.argument.type === AST_NODE_TYPES.Identifier ||
              property.argument.type === AST_NODE_TYPES.ObjectPattern ||
              property.argument.type === AST_NODE_TYPES.ArrayPattern ||
              property.argument.type === AST_NODE_TYPES.AssignmentPattern
            ) {
              return collectBindingNames(property.argument);
            }

            return [];
          }

          return [];
        });
      case AST_NODE_TYPES.ArrayPattern:
        return name.elements.flatMap(element => {
          if (!element) {
            return [];
          }

          if (element.type === AST_NODE_TYPES.RestElement) {
            if (
              element.argument.type === AST_NODE_TYPES.Identifier ||
              element.argument.type === AST_NODE_TYPES.ObjectPattern ||
              element.argument.type === AST_NODE_TYPES.ArrayPattern ||
              element.argument.type === AST_NODE_TYPES.AssignmentPattern
            ) {
              return collectBindingNames(element.argument);
            }

            return [];
          }

          if (
            element.type === AST_NODE_TYPES.Identifier ||
            element.type === AST_NODE_TYPES.ObjectPattern ||
            element.type === AST_NODE_TYPES.ArrayPattern ||
            element.type === AST_NODE_TYPES.AssignmentPattern
          ) {
            return collectBindingNames(element);
          }

          return [];
        });
      case AST_NODE_TYPES.AssignmentPattern:
        return collectBindingNames(name.left);
      case AST_NODE_TYPES.RestElement:
        if (
          name.argument.type === AST_NODE_TYPES.Identifier ||
          name.argument.type === AST_NODE_TYPES.ObjectPattern ||
          name.argument.type === AST_NODE_TYPES.ArrayPattern ||
          name.argument.type === AST_NODE_TYPES.AssignmentPattern
        ) {
          return collectBindingNames(name.argument);
        }

        return [];
    }
  }

  program.body.forEach(statement => {
    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      if (statement.declaration) {
        switch (statement.declaration.type) {
          case AST_NODE_TYPES.VariableDeclaration:
            statement.declaration.declarations.forEach(declaration => {
              collectBindingNames(declaration.id).forEach(bindingName => {
                addExportedBinding(bindingName, false);
              });
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

export function parseExportedBindings(
  filePath: string,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
): Set<string> {
  const cachedBindings = analysisCaches.exportedBindings.get(filePath);

  if (cachedBindings) {
    return cachedBindings;
  }

  const program = parseModule(filePath, analysisCaches);

  if (!program) {
    const emptyBindings = new Set<string>();
    analysisCaches.exportedBindings.set(filePath, emptyBindings);

    return emptyBindings;
  }

  const exportedBindings = collectExportedBindings(program);
  analysisCaches.exportedBindings.set(filePath, exportedBindings);

  return exportedBindings;
}

export function collectAllExportedBindings(
  filePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
  visitedFiles: Set<string> = new Set(),
): Set<string> {
  if (visitedFiles.has(filePath)) {
    return new Set();
  }

  const program = parseModule(filePath, analysisCaches);

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

    const nestedBindings = collectAllExportedBindings(
      resolvedSourceFile,
      resolveImport,
      analysisCaches,
      nextVisitedFiles,
    );

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

export function resolveReExportTarget(
  filePath: string,
  exportedName: string,
  isTypeOnly: boolean,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
  visitedTargets: Set<string> = new Set(),
): ReExportTarget | null {
  const reExportKey = getReExportKey(exportedName, isTypeOnly);
  const visitedTargetKey = `${filePath}:${reExportKey}`;

  if (visitedTargets.has(visitedTargetKey)) {
    return null;
  }

  const program = parseModule(filePath, analysisCaches);

  if (!program) {
    return null;
  }

  const nextVisitedTargets = new Set(visitedTargets);
  nextVisitedTargets.add(visitedTargetKey);

  const barrelAnalysis = collectBarrelAnalysis(program, filePath, resolveImport, analysisCaches, nextVisitedTargets);

  if (!barrelAnalysis) {
    return null;
  }

  return (
    barrelAnalysis.explicitReExports.get(reExportKey) ?? barrelAnalysis.exportAllReExports.get(reExportKey) ?? null
  );
}

export function collectBarrelAnalysis(
  program: TSESTree.Program,
  barrelFilePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
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
        const sourceExportedBindings = parseExportedBindings(resolvedSourceFile, analysisCaches);
        const resolvedTarget =
          resolveReExportTarget(
            resolvedSourceFile,
            specifier.local.name,
            specifierIsTypeOnly,
            resolveImport,
            analysisCaches,
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

        if (!specifierIsTypeOnly && sourceExportedBindings.has(getReExportKey(specifier.local.name, true))) {
          explicitReExports.set(getReExportKey(specifier.exported.name, true), {
            importedName: resolvedTarget.importedName,
            resolvedFilePath: resolvedTarget.resolvedFilePath,
            sourceSpecifier: resolvedTarget.sourceSpecifier,
            isTypeOnly: true,
            fromExportAll: false,
          });
        }
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

      const exportedBindings = collectAllExportedBindings(
        resolvedSourceFile,
        resolveImport,
        analysisCaches,
        new Set([barrelFilePath]),
      );

      exportedBindings.forEach(reExportKey => {
        const { exportedName, isTypeOnly } = getReExportMeta(reExportKey);

        if (statement.exportKind === 'type' && !isTypeOnly) {
          return;
        }

        if (explicitReExports.has(reExportKey) || exportAllReExports.has(reExportKey)) {
          return;
        }

        const resolvedTarget =
          resolveReExportTarget(
            resolvedSourceFile,
            exportedName,
            isTypeOnly,
            resolveImport,
            analysisCaches,
            visitedTargets,
          ) ??
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

export function parseBarrelFile(
  barrelFilePath: string,
  resolveImport: (importerFilename: string, specifier: string) => string | null,
  analysisCaches: AnalysisCaches = createAnalysisCaches(),
): BarrelAnalysis | null {
  const program = parseModule(barrelFilePath, analysisCaches);

  if (!program) {
    return null;
  }

  return collectBarrelAnalysis(program, barrelFilePath, resolveImport, analysisCaches);
}
