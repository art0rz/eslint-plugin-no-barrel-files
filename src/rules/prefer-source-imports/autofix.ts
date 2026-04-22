import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
import { MatchedSpecifier, NamedImportSpecifier } from './types';

export function isTypeOnlyImport(
  declaration: TSESTree.ImportDeclaration,
  specifier: TSESTree.ImportSpecifier | null = null,
): boolean {
  return declaration.importKind === 'type' || specifier?.importKind === 'type';
}

export function serializeImportBinding(importedName: string, localName: string, isTypeOnly: boolean): string {
  if (importedName === 'default') {
    return `${isTypeOnly ? 'type ' : ''}default as ${localName}`;
  }

  const binding = importedName === localName ? importedName : `${importedName} as ${localName}`;

  return isTypeOnly ? `type ${binding}` : binding;
}

export function serializeImportBindings(
  bindings: Array<{ importedName: string; isTypeOnly: boolean; localName: string }>,
  allTypeOnly: boolean,
): string {
  return bindings
    .map(binding =>
      serializeImportBinding(binding.importedName, binding.localName, allTypeOnly ? false : binding.isTypeOnly),
    )
    .join(', ');
}

export function getMergeableImportDeclaration(
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

export function buildAutofix(
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
