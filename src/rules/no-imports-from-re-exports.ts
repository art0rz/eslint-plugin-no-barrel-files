import { TSESLint, AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

type MessageIds = 'noImportFromReExport';

// Caches for performance
const fileAstCache: { [key: string]: ts.SourceFile | null } = {};
const resolveCache: { [key:string]: string | null } = {};

function resolvePath(importPath: string, basedir: string, aliases: Record<string, string>): string | null {
    const cacheKey = `${importPath}|${basedir}`;
    if(resolveCache[cacheKey]) {
        return resolveCache[cacheKey];
    }

    if (importPath.startsWith('.')) {
        let resolvedPath = path.resolve(basedir, importPath);
        if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory()) {
          resolvedPath = path.join(resolvedPath, 'index');
        }

        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
        for (const ext of extensions) {
            if (fs.existsSync(resolvedPath + ext)) {
                resolveCache[cacheKey] = resolvedPath + ext;
                return resolvedPath + ext;
            }
        }
        return null;
    }

    for (const alias in aliases) {
        if (importPath.startsWith(alias)) {
            const remainingPath = importPath.substring(alias.length);
            const resolved = path.join(aliases[alias], remainingPath);
            const resolvedPath = resolvePath(resolved, basedir, aliases);
            if (resolvedPath) {
                resolveCache[cacheKey] = resolvedPath;
                return resolvedPath;
            }
        }
    }

    resolveCache[cacheKey] = null;
    return null;
}

function getFileAst(filePath: string): ts.SourceFile | null {
    if (fileAstCache[filePath]) {
        return fileAstCache[filePath];
    }
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const ast = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    fileAstCache[filePath] = ast;
    return ast;
}

function getOriginalSource(specifierName: string, fileAst: ts.SourceFile, filePath: string, aliases: Record<string, string>): {source: string, isNamespace: boolean} | null {
    let originalSource: {source: string, isNamespace: boolean} | null = null;

    ts.forEachChild(fileAst, (fileNode) => {
        if (ts.isExportDeclaration(fileNode) && fileNode.moduleSpecifier && ts.isStringLiteral(fileNode.moduleSpecifier)) {
            const source = fileNode.moduleSpecifier.text;
            if (fileNode.exportClause && ts.isNamedExports(fileNode.exportClause)) {
                for (const exportSpecifier of fileNode.exportClause.elements) {
                    if (exportSpecifier.name.text === specifierName) {
                        originalSource = { source, isNamespace: false };
                        return;
                    }
                    if (specifierName === 'default' && exportSpecifier.name.text === 'default') {
                        originalSource = { source, isNamespace: false };
                        return;
                    }
                }
            } else if(fileNode.exportClause && ts.isNamespaceExport(fileNode.exportClause)) {
                if (fileNode.exportClause.name.text === specifierName) {
                    originalSource = { source, isNamespace: true };
                    return;
                }
            }
            else if (!fileNode.exportClause) { // export * from './...'
                const resolvedDeeperPath = resolvePath(source, path.dirname(filePath), aliases);
                if (resolvedDeeperPath) {
                    const deeperAst = getFileAst(resolvedDeeperPath);
                    if (deeperAst) {
                        const deeperSource = getOriginalSource(specifierName, deeperAst, resolvedDeeperPath, aliases);
                        if (deeperSource) {
                            originalSource = deeperSource;
                            return;
                        }
                    }
                }
            }
        }
    });

    return originalSource;
}


const noImportsFromReExports: TSESLint.RuleModule<MessageIds, [{ aliases?: Record<string, string> }]> = {
  defaultOptions: [{}],
  meta: {
    type: 'suggestion',
    docs: {
      url: 'https://github.com/art0rz/eslint-plugin-no-barrel-files/blob/main/src/rules/no-imports-from-re-exports.ts',
      description: 'disallow importing from a file that re-exports the symbol',
    },
    fixable: 'code',
    schema: [
        {
            type: 'object',
            properties: {
                aliases: {
                    type: 'object',
                    additionalProperties: {
                        type: 'string'
                    }
                }
            },
            additionalProperties: false
        }
    ],
    messages: {
      noImportFromReExport: 'Import from the original module `{{originalPath}}` instead of the re-export `{{reExportPath}}`.',
    },
  },
  create(context) {
    const currentFilePath = context.getFilename();
    const currentDir = path.dirname(currentFilePath);
    const aliases = context.options[0]?.aliases ?? {};

    return {
        ImportDeclaration(node) {
            const importPath = node.source.value as string;
            if (importPath.includes('node_modules')) {
                return;
            }

            const resolvedImportPath = resolvePath(importPath, currentDir, aliases);
            if (!resolvedImportPath) {
                return;
            }

            const importedFileAst = getFileAst(resolvedImportPath);
            if (!importedFileAst) {
                return;
            }

            for (const specifier of node.specifiers) {
                let specifierName: string | null = null;
                if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
                    specifierName = specifier.imported.name;
                } else if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
                    specifierName = 'default';
                } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
                    continue;
                }

                if (!specifierName) {
                    continue;
                }

                const originalSourceInfo = getOriginalSource(specifierName, importedFileAst, resolvedImportPath, aliases);

                if (originalSourceInfo) {
                    const resolvedOriginalSource = resolvePath(originalSourceInfo.source, path.dirname(resolvedImportPath), aliases);

                    if (resolvedOriginalSource) {
                        let relativePath = path.relative(currentDir, resolvedOriginalSource);
                        if (!relativePath.startsWith('.')) {
                            relativePath = './' + relativePath;
                        }
                        // remove file extension
                        relativePath = relativePath.replace(/\.[^/.]+$/, "");

                        context.report({
                            node: specifier,
                            messageId: 'noImportFromReExport',
                            data: {
                                originalPath: relativePath,
                                reExportPath: importPath,
                            },
                            fix(fixer) {
                                if (originalSourceInfo.isNamespace) {
                                    return fixer.replaceText(node, `import * as ${specifierName} from '${relativePath}';`);
                                }
                                return fixer.replaceText(node.source, `'${relativePath}'`);
                            }
                        });
                    }
                }
            }
        }
    };
  },
};

export default noImportsFromReExports;
