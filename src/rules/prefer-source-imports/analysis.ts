import fs from 'node:fs';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';
import { AnalysisCaches, BarrelAnalysis, ReExportOrigin, ReExportTarget } from './types';

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
    if (
      statement.type === AST_NODE_TYPES.ExportAllDeclaration &&
      statement.exported?.type === AST_NODE_TYPES.Identifier
    ) {
      addExportedBinding(statement.exported.name, statement.exportKind === 'type');
    }

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
  const importedBindings = new Map<string, ReExportOrigin>();

  function resolveSource(
    source: TSESTree.Node | null,
  ): Pick<ReExportOrigin, 'resolvedFilePath' | 'sourceSpecifier'> | null {
    if (source?.type !== AST_NODE_TYPES.Literal || typeof source.value !== 'string') {
      return null;
    }

    const resolvedFilePath = resolveImport(barrelFilePath, source.value);

    return resolvedFilePath ? { resolvedFilePath, sourceSpecifier: source.value } : null;
  }

  // Follow a re-export to the module that really defines it, falling back to the module it names.
  function chaseTarget(
    importedName: string,
    source: Pick<ReExportOrigin, 'resolvedFilePath' | 'sourceSpecifier'>,
    isTypeOnly: boolean,
    fromExportAll: boolean,
  ): ReExportTarget {
    return (
      resolveReExportTarget(
        source.resolvedFilePath,
        importedName,
        isTypeOnly,
        resolveImport,
        analysisCaches,
        visitedTargets,
      ) ?? {
        importedName,
        resolvedFilePath: source.resolvedFilePath,
        sourceSpecifier: source.sourceSpecifier,
        isTypeOnly,
        fromExportAll,
      }
    );
  }

  function toRegisteredTarget(target: ReExportTarget, isTypeOnly: boolean, fromExportAll: boolean): ReExportTarget {
    return {
      importedName: target.importedName,
      resolvedFilePath: target.resolvedFilePath,
      sourceSpecifier: target.sourceSpecifier,
      isTypeOnly,
      fromExportAll,
      isNamespace: target.isNamespace,
    };
  }

  function addExplicitReExport(exportedName: string, origin: ReExportOrigin, exportIsTypeOnly: boolean): void {
    // Re-exporting a type-only import without `type` still only exports a type.
    const isTypeOnly = origin.isTypeOnly || exportIsTypeOnly;
    const target: ReExportTarget = origin.isNamespace
      ? { ...origin, isTypeOnly, fromExportAll: false }
      : chaseTarget(origin.importedName, origin, isTypeOnly, false);

    if (target.resolvedFilePath === barrelFilePath) {
      return;
    }

    explicitReExports.set(getReExportKey(exportedName, isTypeOnly), toRegisteredTarget(target, isTypeOnly, false));

    if (
      !origin.isNamespace &&
      !isTypeOnly &&
      parseExportedBindings(origin.resolvedFilePath, analysisCaches).has(getReExportKey(origin.importedName, true))
    ) {
      explicitReExports.set(getReExportKey(exportedName, true), toRegisteredTarget(target, true, false));
    }
  }

  function addExportAllReExports(statement: TSESTree.ExportAllDeclaration, source: ReturnType<typeof resolveSource>) {
    if (!source) {
      return;
    }

    collectAllExportedBindings(
      source.resolvedFilePath,
      resolveImport,
      analysisCaches,
      new Set([barrelFilePath]),
    ).forEach(reExportKey => {
      const { exportedName, isTypeOnly } = getReExportMeta(reExportKey);

      if (statement.exportKind === 'type' && !isTypeOnly) {
        return;
      }

      if (explicitReExports.has(reExportKey) || exportAllReExports.has(reExportKey)) {
        return;
      }

      const target = chaseTarget(exportedName, source, isTypeOnly, true);

      if (target.resolvedFilePath !== barrelFilePath) {
        exportAllReExports.set(reExportKey, toRegisteredTarget(target, isTypeOnly, true));
      }
    });
  }

  program.body.forEach(statement => {
    if (statement.type !== AST_NODE_TYPES.ImportDeclaration) {
      return;
    }

    const source = resolveSource(statement.source);

    if (!source) {
      return;
    }

    statement.specifiers.forEach(specifier => {
      const isNamespace = specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
      const importedName = isNamespace
        ? '*'
        : specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier
          ? 'default'
          : specifier.type === AST_NODE_TYPES.ImportSpecifier && specifier.imported.type === AST_NODE_TYPES.Identifier
            ? specifier.imported.name
            : null;

      if (!importedName) {
        return;
      }

      importedBindings.set(specifier.local.name, {
        importedName,
        isNamespace,
        isTypeOnly:
          statement.importKind === 'type' ||
          (specifier.type === AST_NODE_TYPES.ImportSpecifier && specifier.importKind === 'type'),
        ...source,
      });
    });
  });

  program.body.forEach(statement => {
    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      const source = resolveSource(statement.source);

      statement.specifiers.forEach(specifier => {
        if (
          specifier.type !== AST_NODE_TYPES.ExportSpecifier ||
          specifier.local.type !== AST_NODE_TYPES.Identifier ||
          specifier.exported.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        const origin = statement.source
          ? source && { importedName: specifier.local.name, isNamespace: false, isTypeOnly: false, ...source }
          : importedBindings.get(specifier.local.name);

        if (origin) {
          addExplicitReExport(
            specifier.exported.name,
            origin,
            statement.exportKind === 'type' || specifier.exportKind === 'type',
          );
        }
      });
    }

    if (
      statement.type === AST_NODE_TYPES.ExportDefaultDeclaration &&
      statement.declaration.type === AST_NODE_TYPES.Identifier
    ) {
      const origin = importedBindings.get(statement.declaration.name);

      if (origin) {
        addExplicitReExport('default', origin, false);
      }
    }

    if (statement.type === AST_NODE_TYPES.ExportAllDeclaration) {
      const source = resolveSource(statement.source);

      if (!statement.exported) {
        addExportAllReExports(statement, source);
      } else if (source && statement.exported.type === AST_NODE_TYPES.Identifier) {
        addExplicitReExport(
          statement.exported.name,
          { importedName: '*', isNamespace: true, isTypeOnly: false, ...source },
          statement.exportKind === 'type',
        );
      }
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
