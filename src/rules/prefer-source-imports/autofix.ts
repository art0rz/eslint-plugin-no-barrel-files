import { AST_NODE_TYPES, TSESLint, TSESTree } from '@typescript-eslint/utils';
import { MatchedSpecifier, NamedImportSpecifier } from './types';

export function isTypeOnlyImport(
  declaration: TSESTree.ImportDeclaration,
  specifier: TSESTree.ImportSpecifier | null = null,
): boolean {
  return declaration.importKind === 'type' || specifier?.importKind === 'type';
}

function hasImportAttributes(node: TSESTree.ImportDeclaration): boolean {
  return (node.attributes?.length ?? 0) > 0;
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
  if (node.source.value !== sourceSpecifier || hasImportAttributes(node)) {
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
  // Attributes on the import describe how the barrel is loaded; we can't tell they still apply to the source module.
  if (hasImportAttributes(currentNode)) {
    return null;
  }

  // Rewriting the declaration from text would delete any comment inside it.
  if (sourceCode.getCommentsInside(currentNode).length > 0) {
    return null;
  }

  const groupedImports = new Map<string, Array<{ importedName: string; isTypeOnly: boolean; localName: string }>>();
  // Attributes the barrel's own re-export declared; the source module needs them wherever it is imported.
  const groupAttributes = new Map<string, string>();

  let conflictingAttributes = false;

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

    if (reExportTarget.attributes) {
      conflictingAttributes ||=
        (groupAttributes.get(preferredSourceSpecifier) ?? reExportTarget.attributes) !== reExportTarget.attributes;
      groupAttributes.set(preferredSourceSpecifier, reExportTarget.attributes);
    } else if (groupAttributes.has(preferredSourceSpecifier)) {
      conflictingAttributes = true;
    }
  });

  if (conflictingAttributes) {
    return null;
  }

  const mergeTargets = new Map<string, TSESTree.ImportDeclaration>();

  for (const sourceSpecifier of groupedImports.keys()) {
    // Merging would apply the attributes to the existing import's other bindings.
    if (groupAttributes.has(sourceSpecifier)) {
      continue;
    }

    const matchingDeclarations = sourceCode.ast.body.filter(
      statement =>
        statement.type === AST_NODE_TYPES.ImportDeclaration &&
        statement !== currentNode &&
        getMergeableImportDeclaration(statement, sourceSpecifier) &&
        sourceCode.getCommentsInside(statement).length === 0,
    ) as TSESTree.ImportDeclaration[];

    if (matchingDeclarations.length > 1) {
      return null;
    }

    if (matchingDeclarations.length === 1) {
      mergeTargets.set(sourceSpecifier, matchingDeclarations[0]!);
    }
  }

  // When every binding merges into an existing import, the declaration is deleted outright. A comment on the line
  // above it (e.g. a directive) would then end up applying to whatever follows.
  if (
    mergeTargets.size === groupedImports.size &&
    sourceCode.getCommentsBefore(currentNode).some(comment => comment.loc.end.line === currentNode.loc.start.line - 1)
  ) {
    return null;
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

        return `import${allTypeOnly ? ' type' : ''} { ${serializedBindings} } from ${quote}${sourceSpecifier}${quote}${groupAttributes.has(sourceSpecifier) ? ` ${groupAttributes.get(sourceSpecifier)}` : ''};`;
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
