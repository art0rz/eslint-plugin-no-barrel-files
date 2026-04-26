/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as parser from '@typescript-eslint/parser';
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import preferSourceImports, { __private__ } from '../prefer-source-imports';

const originalCwd = process.cwd();

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prefer-source-imports-'));
}

function writeFiles(baseDir: string, files: Record<string, string>): void {
  Object.entries(files).forEach(([relativePath, content]) => {
    const absolutePath = path.join(baseDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  });
}

function parseProgram(code: string, filePath = path.join(originalCwd, 'test.ts')) {
  return parser.parse(code, {
    filePath,
    ecmaVersion: 'latest',
    sourceType: 'module',
    range: true,
  });
}

function createSourceCode(code: string, filePath = path.join(originalCwd, 'test.ts')) {
  return {
    ast: parseProgram(code, filePath),
    text: code,
  } as any;
}

function createFixer() {
  return {
    removeRange: (range: [number, number]) => ({ type: 'removeRange', range }),
    replaceText: (node: { range: [number, number] }, text: string) => ({
      type: 'replaceText',
      range: node.range,
      text,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __private__.setTypeScriptModuleLoaderForTests(null);
  process.chdir(originalCwd);
});

describe('prefer-source-imports private helpers', () => {
  it('covers the basic string and path helpers', () => {
    expect(__private__.isRelativePath('./foo')).toBe(true);
    expect(__private__.isRelativePath('foo')).toBe(false);

    expect(__private__.matchesAliasPattern('@app/foo', '@app/*')).toBe('foo');
    expect(__private__.matchesAliasPattern('@app/foo', '@app/bar')).toBeNull();
    expect(__private__.matchesAliasPattern('@app/bar', '@app/bar')).toBe('');

    expect(__private__.applyAliasTarget('src/*', 'foo')).toBe('src/foo');
    expect(__private__.applyAliasTarget('src/app', 'foo')).toBe('src/app');

    expect(__private__.buildAliasSpecifier('@app/*', 'foo')).toBe('@app/foo');
    expect(__private__.buildAliasSpecifier('@app', 'foo')).toBe('@app');

    expect(__private__.normalizeModulePath('foo/index.ts')).toBe('foo');
    expect(__private__.normalizeModulePath('foo/bar.ts')).toBe('foo/bar');

    expect(__private__.toRelativeImportSpecifier('/repo/src/consumer.ts', '/repo/src/nested/foo.ts')).toBe(
      './nested/foo',
    );
    expect(__private__.toRelativeImportSpecifier('/repo/src/nested/consumer.ts', '/repo/src/foo.ts')).toBe('../foo');

    expect(__private__.getReExportKey('Foo', true)).toBe('type:Foo');
    expect(__private__.getReExportMeta('type:Foo')).toEqual({ exportedName: 'Foo', isTypeOnly: true });
    expect(__private__.getReExportMeta('value:Foo')).toEqual({ exportedName: 'Foo', isTypeOnly: false });
    expect(__private__.shouldReportMissingTypeScript('/repo/src/file.ts', {})).toBe(false);
    expect(__private__.shouldReportMissingTypeScript('/repo/src/file.js', {})).toBe(false);
  });

  it('covers optional TypeScript dependency helpers', () => {
    __private__.setTypeScriptModuleLoaderForTests(() => null);

    expect(__private__.getTypeScriptModule()).toBeNull();
    expect(__private__.hasTypeScriptModule()).toBe(false);
    expect(__private__.shouldReportMissingTypeScript('/repo/src/file.ts', {})).toBe(true);
    expect(__private__.shouldReportMissingTypeScript('/repo/src/file.ts', { tsconfig: false })).toBe(false);
    expect(__private__.getTsconfigPath({}, '/repo/src/file.ts')).toBeNull();
    expect(__private__.resolveWithTsconfig({}, '/repo/src/file.ts', '@app/foo', new Map())).toBeNull();

    __private__.setTypeScriptModuleLoaderForTests(
      () =>
        ({
          findConfigFile: () => undefined,
          sys: {
            fileExists: () => false,
          },
        }) as any,
    );

    expect(__private__.hasTypeScriptModule()).toBe(true);
    expect(__private__.shouldReportMissingTypeScript('/repo/src/file.tsx', {})).toBe(false);
    expect(__private__.getTsconfigPath({ tsconfig: false }, '/repo/src/file.ts')).toBeNull();
    expect(__private__.getTsconfigPath({}, '/repo/src/file.ts')).toBeNull();
  });

  it('covers parseModule read and parse failures', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(__private__.parseModule('/tmp/missing.ts')).toBeNull();

    vi.restoreAllMocks();

    const filePath = path.join(makeTempDir(), 'broken.ts');
    fs.writeFileSync(filePath, 'export const Foo = 1;');
    vi.spyOn(parser, 'parse').mockImplementation(() => {
      throw new Error('bad parse');
    });

    expect(__private__.parseModule(filePath)).toBeNull();
  });

  it('collects exported bindings across declaration kinds and skips unsupported specifiers', () => {
    const program = {
      body: [
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.VariableDeclaration,
            declarations: [
              { id: { type: AST_NODE_TYPES.Identifier, name: 'ValueVar' } },
              {
                id: {
                  type: AST_NODE_TYPES.ObjectPattern,
                  properties: [
                    {
                      type: AST_NODE_TYPES.Property,
                      value: { type: AST_NODE_TYPES.Identifier, name: 'ObjectValue' },
                    },
                    {
                      type: AST_NODE_TYPES.Property,
                      value: {
                        type: AST_NODE_TYPES.AssignmentPattern,
                        left: { type: AST_NODE_TYPES.Identifier, name: 'AssignedValue' },
                      },
                    },
                    {
                      type: AST_NODE_TYPES.Property,
                      value: {
                        type: AST_NODE_TYPES.Literal,
                        value: 'skip-non-binding-object-value',
                      },
                    },
                    {
                      type: AST_NODE_TYPES.RestElement,
                      argument: { type: AST_NODE_TYPES.Identifier, name: 'RestValue' },
                    },
                    {
                      type: AST_NODE_TYPES.RestElement,
                      argument: {
                        type: AST_NODE_TYPES.MemberExpression,
                      },
                    },
                    {
                      type: 'ExperimentalObjectPatternProperty',
                    },
                  ],
                },
              },
              {
                id: {
                  type: AST_NODE_TYPES.ArrayPattern,
                  elements: [
                    { type: AST_NODE_TYPES.Identifier, name: 'ArrayValue' },
                    null,
                    {
                      type: AST_NODE_TYPES.AssignmentPattern,
                      left: { type: AST_NODE_TYPES.Identifier, name: 'NestedValue' },
                    },
                    {
                      type: AST_NODE_TYPES.RestElement,
                      argument: { type: AST_NODE_TYPES.Identifier, name: 'ArrayRestValue' },
                    },
                    {
                      type: AST_NODE_TYPES.RestElement,
                      argument: {
                        type: AST_NODE_TYPES.MemberExpression,
                      },
                    },
                    {
                      type: AST_NODE_TYPES.MemberExpression,
                    },
                  ],
                },
              },
              {
                id: {
                  type: AST_NODE_TYPES.RestElement,
                  argument: { type: AST_NODE_TYPES.Identifier, name: 'TopLevelRestValue' },
                },
              },
              {
                id: {
                  type: AST_NODE_TYPES.RestElement,
                  argument: {
                    type: AST_NODE_TYPES.MemberExpression,
                  },
                },
              },
            ],
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.FunctionDeclaration,
            id: null,
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.FunctionDeclaration,
            id: { type: AST_NODE_TYPES.Identifier, name: 'NamedFn' },
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.ClassDeclaration,
            id: null,
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.ClassDeclaration,
            id: { type: AST_NODE_TYPES.Identifier, name: 'NamedClass' },
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.TSEnumDeclaration,
            id: { type: AST_NODE_TYPES.Identifier, name: 'NamedEnum' },
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.TSInterfaceDeclaration,
            id: { type: AST_NODE_TYPES.Identifier, name: 'NamedInterface' },
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.TSTypeAliasDeclaration,
            id: null,
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: {
            type: AST_NODE_TYPES.TSTypeAliasDeclaration,
            id: { type: AST_NODE_TYPES.Identifier, name: 'NamedAlias' },
          },
          specifiers: [],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          declaration: null,
          exportKind: 'value',
          specifiers: [
            { type: 'ExportDefaultSpecifier' },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'value',
              exported: { type: AST_NODE_TYPES.Literal, value: 'Skipped' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'Skipped' },
            },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'type',
              exported: { type: AST_NODE_TYPES.Identifier, name: 'TypeFromSpecifier' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'TypeFromSpecifier' },
            },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'value',
              exported: { type: AST_NODE_TYPES.Identifier, name: 'ValueFromSpecifier' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'ValueFromSpecifier' },
            },
          ],
        },
        {
          type: AST_NODE_TYPES.ExpressionStatement,
        },
      ],
    } as any;

    expect(Array.from(__private__.collectExportedBindings(program)).sort()).toEqual([
      'type:NamedAlias',
      'type:NamedClass',
      'type:NamedEnum',
      'type:NamedInterface',
      'type:TypeFromSpecifier',
      'value:ArrayRestValue',
      'value:ArrayValue',
      'value:AssignedValue',
      'value:NamedClass',
      'value:NamedEnum',
      'value:NamedFn',
      'value:NestedValue',
      'value:ObjectValue',
      'value:RestValue',
      'value:TopLevelRestValue',
      'value:ValueFromSpecifier',
      'value:ValueVar',
    ]);
  });

  it('returns an empty binding set when parseExportedBindings cannot parse the file', () => {
    const brokenFile = path.join(makeTempDir(), 'broken.ts');
    fs.writeFileSync(brokenFile, 'export const =');

    expect(Array.from(__private__.parseExportedBindings(brokenFile))).toEqual([]);
  });

  it('recursively resolves export-all bindings and re-export targets with cycle protection', () => {
    const tempDir = makeTempDir();
    const resolve = (importerFilename: string, specifier: string) =>
      __private__.resolveModuleFile(importerFilename, specifier);
    const analysisCaches = __private__.createAnalysisCaches();
    const valueFile = path.join(tempDir, 'value.ts');
    const explicitLeafFile = path.join(tempDir, 'explicit-leaf.ts');
    const starLeafFile = path.join(tempDir, 'star-leaf.ts');

    writeFiles(tempDir, {
      'value.ts': 'export const Foo = 1;',
      'types.ts': 'export type TypeFoo = { value: string };',
      'explicit-leaf.ts': "export { Foo } from './value';\nexport type { TypeFoo } from './types';",
      'explicit-barrel.ts': "export { Foo } from './explicit-leaf';\nexport type { TypeFoo } from './explicit-leaf';",
      'star-leaf.ts': "export * from './value';\nexport type * from './types';",
      'star-barrel.ts': "export * from './star-leaf';",
      'cycle-a.ts': "export * from './cycle-b';",
      'cycle-b.ts': "export * from './cycle-a';",
    });

    expect(Array.from(__private__.collectAllExportedBindings(starLeafFile, resolve, analysisCaches)).sort()).toEqual([
      'type:TypeFoo',
      'value:Foo',
    ]);
    expect(
      Array.from(
        __private__.collectAllExportedBindings(
          starLeafFile,
          resolve,
          __private__.createAnalysisCaches(),
          new Set([starLeafFile]),
        ),
      ),
    ).toEqual([]);

    expect(__private__.resolveReExportTarget(explicitLeafFile, 'Foo', false, resolve)).toEqual({
      importedName: 'Foo',
      resolvedFilePath: valueFile,
      sourceSpecifier: './value',
      isTypeOnly: false,
      fromExportAll: false,
    });
    expect(__private__.resolveReExportTarget(explicitLeafFile, 'TypeFoo', true, resolve)).toEqual({
      importedName: 'TypeFoo',
      resolvedFilePath: path.join(tempDir, 'types.ts'),
      sourceSpecifier: './types',
      isTypeOnly: true,
      fromExportAll: false,
    });
    expect(__private__.resolveReExportTarget(starLeafFile, 'Foo', false, resolve)).toEqual({
      importedName: 'Foo',
      resolvedFilePath: valueFile,
      sourceSpecifier: './value',
      isTypeOnly: false,
      fromExportAll: true,
    });
    expect(__private__.resolveReExportTarget(starLeafFile, 'Missing', false, resolve)).toBeNull();
    expect(
      __private__.resolveReExportTarget(
        explicitLeafFile,
        'Foo',
        false,
        resolve,
        __private__.createAnalysisCaches(),
        new Set([`${explicitLeafFile}:value:Foo`]),
      ),
    ).toBeNull();
    expect(__private__.resolveReExportTarget(path.join(tempDir, 'cycle-a.ts'), 'Foo', false, resolve)).toBeNull();

    const explicitAnalysis = __private__.parseBarrelFile(path.join(tempDir, 'explicit-barrel.ts'), resolve);
    expect(explicitAnalysis?.explicitReExports.get('value:Foo')).toEqual({
      importedName: 'Foo',
      resolvedFilePath: valueFile,
      sourceSpecifier: './value',
      isTypeOnly: false,
      fromExportAll: false,
    });
    expect(explicitAnalysis?.explicitReExports.get('type:TypeFoo')).toEqual({
      importedName: 'TypeFoo',
      resolvedFilePath: path.join(tempDir, 'types.ts'),
      sourceSpecifier: './types',
      isTypeOnly: true,
      fromExportAll: false,
    });

    const starAnalysis = __private__.parseBarrelFile(path.join(tempDir, 'star-barrel.ts'), resolve);
    expect(starAnalysis?.exportAllReExports.get('value:Foo')).toEqual({
      importedName: 'Foo',
      resolvedFilePath: valueFile,
      sourceSpecifier: './value',
      isTypeOnly: false,
      fromExportAll: true,
    });
    expect(starAnalysis?.exportAllReExports.get('type:TypeFoo')).toEqual({
      importedName: 'TypeFoo',
      resolvedFilePath: path.join(tempDir, 'types.ts'),
      sourceSpecifier: './types',
      isTypeOnly: true,
      fromExportAll: true,
    });
  });

  it('covers recursive helper fallback branches and self-referential re-export skips', () => {
    const tempDir = makeTempDir();
    const resolve = (importerFilename: string, specifier: string) =>
      __private__.resolveModuleFile(importerFilename, specifier);
    const analysisCaches = __private__.createAnalysisCaches();

    writeFiles(tempDir, {
      'duplicate-source.ts': 'export const Foo = 1;',
      'duplicate-star.ts': "export const Foo = 1;\nexport * from './duplicate-source';",
      'missing-export-all.ts': "export * from './missing-source';",
      'type-star-value.ts': "export type * from './duplicate-source';",
      'explicit-cycle-a.ts': "export * from './explicit-cycle-b';",
      'explicit-cycle-b.ts': "export { Foo } from './explicit-cycle-a';",
      'export-all-cycle-a.ts': "export * from './export-all-cycle-b';",
      'export-all-cycle-b.ts': "export * from './export-all-cycle-c';",
      'export-all-cycle-c.ts': "export { Foo } from './export-all-cycle-a';",
    });

    expect(Array.from(__private__.parseExportedBindings(path.join(tempDir, 'duplicate-source.ts')))).toEqual([
      'value:Foo',
    ]);
    expect(
      Array.from(__private__.collectAllExportedBindings(path.join(tempDir, 'missing.ts'), resolve, analysisCaches)),
    ).toEqual([]);
    expect(
      Array.from(
        __private__.collectAllExportedBindings(path.join(tempDir, 'duplicate-star.ts'), resolve, analysisCaches),
      ),
    ).toEqual(['value:Foo']);
    expect(
      Array.from(
        __private__.collectAllExportedBindings(path.join(tempDir, 'missing-export-all.ts'), resolve, analysisCaches),
      ),
    ).toEqual([]);
    expect(
      Array.from(
        __private__.collectAllExportedBindings(path.join(tempDir, 'type-star-value.ts'), resolve, analysisCaches),
      ),
    ).toEqual([]);
    expect(__private__.resolveReExportTarget(path.join(tempDir, 'missing.ts'), 'Foo', false, resolve)).toBeNull();
    expect(
      __private__.resolveReExportTarget(path.join(tempDir, 'explicit-cycle-b.ts'), 'Foo', false, resolve),
    ).toBeNull();
    expect(
      __private__.resolveReExportTarget(path.join(tempDir, 'export-all-cycle-b.ts'), 'Foo', false, resolve),
    ).toBeNull();
  });

  it('collects barrel analysis and skips invalid or unresolved re-exports', () => {
    const tempDir = makeTempDir();
    const valueFile = path.join(tempDir, 'value.ts');
    const starFile = path.join(tempDir, 'star.ts');
    const typesFile = path.join(tempDir, 'types.ts');

    writeFiles(tempDir, {
      'value.ts': 'export const Foo = 1;',
      'star.ts': 'export const FromStar = 1;\nexport type FromStarType = { value: string };',
      'types.ts': 'export type TypeOnly = { value: string };',
    });

    const program = {
      body: [
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          exportKind: 'value',
          source: { type: AST_NODE_TYPES.Literal, value: './missing-explicit' },
          specifiers: [
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'value',
              exported: { type: AST_NODE_TYPES.Identifier, name: 'Missing' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'Missing' },
            },
          ],
        },
        {
          type: AST_NODE_TYPES.ExportNamedDeclaration,
          exportKind: 'value',
          source: { type: AST_NODE_TYPES.Literal, value: './value' },
          specifiers: [
            { type: 'ExportDefaultSpecifier' },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'value',
              exported: { type: AST_NODE_TYPES.Literal, value: 'Skipped' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'Skipped' },
            },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'value',
              exported: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
            },
            {
              type: AST_NODE_TYPES.ExportSpecifier,
              exportKind: 'type',
              exported: { type: AST_NODE_TYPES.Identifier, name: 'TypeOnly' },
              local: { type: AST_NODE_TYPES.Identifier, name: 'TypeOnly' },
            },
          ],
        },
        {
          type: AST_NODE_TYPES.ExportAllDeclaration,
          exportKind: 'value',
          exported: null,
          source: { type: AST_NODE_TYPES.Literal, value: './star' },
        },
        {
          type: AST_NODE_TYPES.ExportAllDeclaration,
          exportKind: 'type',
          exported: null,
          source: { type: AST_NODE_TYPES.Literal, value: './value' },
        },
        {
          type: AST_NODE_TYPES.ExportAllDeclaration,
          exportKind: 'type',
          exported: null,
          source: { type: AST_NODE_TYPES.Literal, value: './types' },
        },
        {
          type: AST_NODE_TYPES.ExportAllDeclaration,
          exportKind: 'value',
          exported: null,
          source: { type: AST_NODE_TYPES.Literal, value: './missing-star' },
        },
      ],
    } as any;

    const analysis = __private__.collectBarrelAnalysis(
      program,
      path.join(tempDir, 'barrel.ts'),
      (_importer, specifier) => {
        switch (specifier) {
          case './value':
            return valueFile;
          case './star':
            return starFile;
          case './types':
            return typesFile;
          default:
            return null;
        }
      },
    );

    expect(analysis).not.toBeNull();
    expect(Array.from(analysis!.explicitReExports.keys()).sort()).toEqual(['type:TypeOnly', 'value:Foo']);
    expect(Array.from(analysis!.exportAllReExports.keys()).sort()).toEqual(['type:FromStarType', 'value:FromStar']);
  });

  it('returns null barrel analysis when nothing is re-exported', () => {
    const program = { body: [] } as any;
    expect(__private__.collectBarrelAnalysis(program, '/tmp/barrel.ts', () => null)).toBeNull();
  });

  it('returns null when parseBarrelFile cannot parse the barrel module', () => {
    const brokenFile = path.join(makeTempDir(), 'barrel.ts');
    fs.writeFileSync(brokenFile, 'export {');
    expect(__private__.parseBarrelFile(brokenFile, () => null)).toBeNull();
  });

  it('covers module resolution helpers and alias mapping helpers', () => {
    const tempDir = makeTempDir();
    writeFiles(tempDir, {
      'src/foo.ts': 'export const Foo = 1;',
      'src/index.ts': 'export const Index = 1;',
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@app/*': ['src/*'],
              '@dup-a/*': ['src/*'],
              '@dup-b/*': ['src/*'],
            },
          },
        },
        null,
        2,
      ),
      'tsconfig-no-paths.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
          },
        },
        null,
        2,
      ),
      'tsconfig-exact.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@exact': ['src/foo'],
            },
          },
        },
        null,
        2,
      ),
      'tsconfig-duplicate.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@dup-a/*': ['src/*'],
              '@dup-b/*': ['src/*'],
            },
          },
        },
        null,
        2,
      ),
    });

    const importer = path.join(tempDir, 'consumer.ts');
    const tsconfigCache = new Map<string, any>();
    const resolutionCaches = __private__.createResolutionCaches(tsconfigCache);
    const options = {
      paths: {
        '@manual/*': ['missing/*', 'src/*'],
        '@single': 'src/foo',
      },
    };

    expect(__private__.resolveModuleFile(importer, './src/foo')).toBe(path.join(tempDir, 'src/foo.ts'));
    expect(__private__.resolveModuleFile(importer, './src')).toBe(path.join(tempDir, 'src/index.ts'));
    expect(__private__.resolveModuleFile(importer, './missing')).toBeNull();

    expect(__private__.getManualAliasMappings(undefined)).toEqual([]);
    expect(__private__.getManualAliasMappings(options)).toEqual([
      { pattern: '@manual/*', target: 'missing/*' },
      { pattern: '@manual/*', target: 'src/*' },
      { pattern: '@single', target: 'src/foo' },
    ]);

    expect(__private__.resolveWithManualPaths(undefined, importer, '@manual/foo', tempDir)).toBeNull();
    expect(__private__.resolveWithManualPaths(options, importer, '@manual/foo', tempDir)).toBe(
      path.join(tempDir, 'src/foo.ts'),
    );
    expect(__private__.resolveWithManualPaths(options, importer, '@missing/foo', tempDir)).toBeNull();

    expect(__private__.getTsconfigPath({ tsconfig: false }, importer, tempDir)).toBeNull();
    expect(__private__.getTsconfigPath({ tsconfig: path.join(tempDir, 'tsconfig.json') }, importer, tempDir)).toBe(
      path.join(tempDir, 'tsconfig.json'),
    );
    expect(__private__.getTsconfigPath({ tsconfig: 'tsconfig.json' }, importer, tempDir)).toBe(
      path.join(tempDir, 'tsconfig.json'),
    );
    expect(__private__.getTsconfigPath({}, importer, tempDir)).toBe(path.join(tempDir, 'tsconfig.json'));

    expect(__private__.getTsconfigInfo({ tsconfig: false }, importer, tsconfigCache, tempDir)).toBeNull();
    expect(__private__.getTsconfigInfo({}, importer, tsconfigCache, tempDir)?.configFilePath).toBe(
      path.join(tempDir, 'tsconfig.json'),
    );

    expect(__private__.resolveWithTsconfig({}, importer, '@app/foo', tsconfigCache, tempDir)).toBe(
      path.join(tempDir, 'src/foo.ts'),
    );
    expect(__private__.resolveWithTsconfig({ tsconfig: false }, importer, '@app/foo', new Map(), tempDir)).toBeNull();

    expect(__private__.resolveImport({}, resolutionCaches, importer, './src/foo', tempDir)).toBe(
      path.join(tempDir, 'src/foo.ts'),
    );
    expect(__private__.resolveImport(options, resolutionCaches, importer, '@manual/foo', tempDir)).toBe(
      path.join(tempDir, 'src/foo.ts'),
    );
    expect(__private__.resolveImport({}, resolutionCaches, importer, '@app/foo', tempDir)).toBe(
      path.join(tempDir, 'src/foo.ts'),
    );

    expect(__private__.reverseResolveManualAlias(options, path.join(tempDir, 'src/foo.ts'), tempDir)).toBeNull();
    expect(
      __private__.reverseResolveManualAlias(
        { paths: { '@single': 'src/foo' } },
        path.join(tempDir, 'src/foo.ts'),
        tempDir,
      ),
    ).toBe('@single');
    expect(
      __private__.reverseResolveManualAlias(
        { paths: { '@single': 'src/bar' } },
        path.join(tempDir, 'src/foo.ts'),
        tempDir,
      ),
    ).toBeNull();

    expect(
      __private__.reverseResolveTsconfigAlias(
        { tsconfig: false },
        importer,
        path.join(tempDir, 'src/foo.ts'),
        tsconfigCache,
        tempDir,
      ),
    ).toBeNull();
    expect(
      __private__.reverseResolveTsconfigAlias(
        { tsconfig: path.join(tempDir, 'tsconfig-no-paths.json') },
        importer,
        path.join(tempDir, 'src/foo.ts'),
        new Map(),
        tempDir,
      ),
    ).toBeNull();
    expect(
      __private__.reverseResolveTsconfigAlias(
        { paths: { '@app/*': 'src/*' } },
        importer,
        path.join(tempDir, 'src/foo.ts'),
        new Map(),
        tempDir,
      ),
    ).toBeNull();
    expect(
      __private__.reverseResolveTsconfigAlias({}, importer, path.join(tempDir, 'outside/foo.ts'), new Map(), tempDir),
    ).toBeNull();
    expect(
      __private__.reverseResolveTsconfigAlias(
        { tsconfig: path.join(tempDir, 'tsconfig-exact.json') },
        importer,
        path.join(tempDir, 'src/foo.ts'),
        new Map(),
        tempDir,
      ),
    ).toBe('@exact');
    expect(
      __private__.reverseResolveTsconfigAlias(
        { tsconfig: path.join(tempDir, 'tsconfig-exact.json') },
        importer,
        path.join(tempDir, 'src/index.ts'),
        new Map(),
        tempDir,
      ),
    ).toBeNull();
    expect(
      __private__.reverseResolveTsconfigAlias(
        { tsconfig: path.join(tempDir, 'tsconfig-duplicate.json') },
        importer,
        path.join(tempDir, 'src/foo.ts'),
        new Map(),
        tempDir,
      ),
    ).toBeNull();

    const tsAlias = __private__.getPreferredSourceSpecifier(
      {},
      importer,
      '@app/barrel',
      {
        importedName: 'Foo',
        resolvedFilePath: path.join(tempDir, 'src/foo.ts'),
        sourceSpecifier: './foo',
        isTypeOnly: false,
        fromExportAll: false,
      },
      new Map(),
      tempDir,
    );

    expect(tsAlias).toBe('./src/foo');
    expect(
      __private__.getPreferredSourceSpecifier(
        {},
        importer,
        './barrel',
        {
          importedName: 'Foo',
          resolvedFilePath: path.join(tempDir, 'src/foo.ts'),
          sourceSpecifier: '@app/foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
        new Map(),
        tempDir,
      ),
    ).toBe('@app/foo');
  });

  it('covers tsconfig error and module resolution error branches via real files', () => {
    const brokenDir = makeTempDir();
    writeFiles(brokenDir, {
      'tsconfig.json': '{ invalid json ',
    });

    expect(__private__.getTsconfigInfo({}, path.join(brokenDir, 'consumer.ts'), new Map(), brokenDir)).toBeNull();

    const validDir = makeTempDir();
    writeFiles(validDir, {
      'src/foo.ts': 'export const Foo = 1;',
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@app/*': ['src/*'],
            },
          },
        },
        null,
        2,
      ),
    });

    const importer = path.join(validDir, 'consumer.ts');
    expect(__private__.resolveWithTsconfig({}, importer, 'vitest', new Map(), validDir)).toBeNull();

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(__private__.resolveWithTsconfig({}, importer, '@app/foo', new Map(), validDir)).toBeNull();
  });

  it('covers alias-preservation branches and cached barrel analysis', () => {
    const tempDir = makeTempDir();
    writeFiles(tempDir, {
      'src/foo.ts': 'export const Foo = 1;',
      'src/barrel.ts': "export { Foo } from './foo';",
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@app/*': ['src/*'],
            },
          },
        },
        null,
        2,
      ),
    });

    const importer = path.join(tempDir, 'consumer.ts');
    const target = {
      importedName: 'Foo',
      resolvedFilePath: path.join(tempDir, 'src/foo.ts'),
      sourceSpecifier: '@app/foo',
      isTypeOnly: false,
      fromExportAll: false,
    };
    const tsconfigCache = new Map<string, any>();

    expect(
      __private__.getPreferredSourceSpecifier(
        { fixStyle: 'relative' },
        importer,
        '@app/barrel',
        target,
        tsconfigCache,
        tempDir,
      ),
    ).toBe('./src/foo');
    expect(
      __private__.getPreferredSourceSpecifier(
        { fixStyle: 'preserve-alias' },
        importer,
        '@app/barrel',
        { ...target, sourceSpecifier: './foo' },
        tsconfigCache,
        tempDir,
      ),
    ).toBe('@app/foo');
    expect(
      __private__.getPreferredSourceSpecifier(
        {
          fixStyle: 'preserve-alias',
          tsconfig: false,
          paths: {
            '@dup-a/*': 'src/*',
            '@dup-b/*': 'src/*',
          },
        },
        importer,
        '@dup-a/barrel',
        { ...target, sourceSpecifier: './foo' },
        new Map(),
        tempDir,
      ),
    ).toBeNull();

    const barrelExportCache = new Map<string, any>();
    const barrelFilePath = path.join(tempDir, 'src/barrel.ts');
    const resolutionCaches = __private__.createResolutionCaches(new Map());
    const analysisCaches = __private__.createAnalysisCaches();
    const first = __private__.getBarrelAnalysis(
      {},
      barrelFilePath,
      barrelExportCache,
      resolutionCaches,
      analysisCaches,
      tempDir,
    );
    const second = __private__.getBarrelAnalysis(
      {},
      barrelFilePath,
      barrelExportCache,
      resolutionCaches,
      analysisCaches,
      tempDir,
    );
    expect(first).toBe(second);

    const anotherBarrelExportCache = new Map<string, any>();
    const reusedFromResolutionCache = __private__.getBarrelAnalysis(
      {},
      barrelFilePath,
      anotherBarrelExportCache,
      resolutionCaches,
      __private__.createAnalysisCaches(),
      tempDir,
    );
    expect(reusedFromResolutionCache).toBe(first);
  });

  it('uses fresh analysis caches to observe rewritten barrel files across lint runs', () => {
    const tempDir = makeTempDir();
    const resolve = (importerFilename: string, specifier: string) =>
      __private__.resolveModuleFile(importerFilename, specifier);
    const barrelFilePath = path.join(tempDir, 'barrel.ts');

    writeFiles(tempDir, {
      'value-a.ts': 'export const Foo = 1;',
      'value-b.ts': 'export const Bar = 1;',
      'barrel.ts': "export { Foo } from './value-a';",
    });

    const initialCaches = __private__.createAnalysisCaches();
    expect(
      __private__.parseBarrelFile(barrelFilePath, resolve, initialCaches)?.explicitReExports.get('value:Foo')
        ?.resolvedFilePath,
    ).toBe(path.join(tempDir, 'value-a.ts'));

    fs.writeFileSync(barrelFilePath, "export { Bar } from './value-b';");

    expect(
      __private__.parseBarrelFile(barrelFilePath, resolve, initialCaches)?.explicitReExports.has('value:Foo'),
    ).toBe(true);
    expect(
      __private__.parseBarrelFile(barrelFilePath, resolve, initialCaches)?.explicitReExports.has('value:Bar'),
    ).toBe(false);

    const freshCaches = __private__.createAnalysisCaches();
    expect(
      __private__.parseBarrelFile(barrelFilePath, resolve, freshCaches)?.explicitReExports.get('value:Bar')
        ?.resolvedFilePath,
    ).toBe(path.join(tempDir, 'value-b.ts'));
    expect(__private__.parseBarrelFile(barrelFilePath, resolve, freshCaches)?.explicitReExports.has('value:Foo')).toBe(
      false,
    );
  });

  it('covers import serialization helpers and mergeable import detection', () => {
    expect(__private__.serializeImportBinding('default', 'Foo', true)).toBe('type default as Foo');
    expect(__private__.serializeImportBinding('Foo', 'Bar', false)).toBe('Foo as Bar');
    expect(
      __private__.serializeImportBindings(
        [
          { importedName: 'Foo', isTypeOnly: true, localName: 'Foo' },
          { importedName: 'Bar', isTypeOnly: false, localName: 'Baz' },
        ],
        false,
      ),
    ).toBe('type Foo, Bar as Baz');
    expect(
      __private__.serializeImportBindings([{ importedName: 'Foo', isTypeOnly: true, localName: 'Foo' }], true),
    ).toBe('Foo');

    const validImport = parseProgram("import { Foo } from './foo';").body[0] as any;
    const defaultImport = parseProgram("import Foo from './foo';").body[0] as any;
    expect(__private__.getMergeableImportDeclaration(validImport, './bar')).toBeNull();
    expect(__private__.getMergeableImportDeclaration(defaultImport, './foo')).toBeNull();
    expect(__private__.getMergeableImportDeclaration(validImport, './foo')).toBe(validImport);
  });

  it('covers autofix removal, merge conflicts, and duplicate merge-target detection', () => {
    const code = "import { Foo } from './barrel';";
    const sourceCode = createSourceCode(code);
    const currentNode = sourceCode.ast.body[0] as any;
    const matchedSpecifier = {
      preferredSourceSpecifier: null,
      specifier: currentNode.specifiers[0],
      reExportTarget: {
        importedName: 'Foo',
        resolvedFilePath: '/tmp/foo.ts',
        sourceSpecifier: './foo',
        isTypeOnly: false,
        fromExportAll: false,
      },
    };
    const removeOnlyFix = __private__.buildAutofix(sourceCode, currentNode, [matchedSpecifier as any]);
    expect(removeOnlyFix?.(createFixer() as any)).toEqual([{ type: 'removeRange', range: [0, code.length] }]);

    const newlineCode = "import { Foo } from './barrel';\n";
    const newlineSourceCode = createSourceCode(newlineCode);
    const newlineCurrentNode = newlineSourceCode.ast.body[0] as any;
    const removeWithNewlineFix = __private__.buildAutofix(newlineSourceCode, newlineCurrentNode, [
      {
        ...matchedSpecifier,
        specifier: newlineCurrentNode.specifiers[0],
      } as any,
    ]);
    expect(removeWithNewlineFix?.(createFixer() as any)).toEqual([
      { type: 'removeRange', range: [0, newlineCode.length] },
    ]);

    const duplicateSourceCode = createSourceCode(
      "import { Existing } from './foo';\nimport { Other } from './foo';\nimport { Foo } from './barrel';",
    );
    const duplicateCurrentNode = duplicateSourceCode.ast.body[2] as any;
    expect(
      __private__.buildAutofix(duplicateSourceCode, duplicateCurrentNode, [
        {
          preferredSourceSpecifier: './foo',
          specifier: duplicateCurrentNode.specifiers[0],
          reExportTarget: {
            importedName: 'Foo',
            resolvedFilePath: '/tmp/foo.ts',
            sourceSpecifier: './foo',
            isTypeOnly: false,
            fromExportAll: false,
          },
        } as any,
      ]),
    ).toBeNull();

    const conflictingSourceCode = createSourceCode(
      "import { Bar as Foo } from './foo';\nimport { Foo } from './barrel';",
    );
    const conflictingCurrentNode = conflictingSourceCode.ast.body[1] as any;
    const conflictingFix = __private__.buildAutofix(conflictingSourceCode, conflictingCurrentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: conflictingCurrentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Foo',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
      } as any,
    ]);
    expect(conflictingFix?.(createFixer() as any)).toBeNull();

    const typeConflictSourceCode = createSourceCode(
      "import { Existing } from './foo';\nimport { Existing } from './barrel';",
    );
    const typeConflictCurrentNode = typeConflictSourceCode.ast.body[1] as any;
    const typeConflictFix = __private__.buildAutofix(typeConflictSourceCode, typeConflictCurrentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: typeConflictCurrentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Existing',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
      },
      {
        preferredSourceSpecifier: './foo',
        specifier: typeConflictCurrentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Existing',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: true,
          fromExportAll: false,
        },
      },
    ] as any);
    expect(typeConflictFix?.(createFixer() as any)).toBeNull();
  });

  it('covers merge-target internal conflicts and quote handling in autofix output', () => {
    const currentNode = {
      type: AST_NODE_TYPES.ImportDeclaration,
      source: { value: './barrel', raw: '"./barrel"' },
      specifiers: [
        {
          type: AST_NODE_TYPES.ImportSpecifier,
          imported: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
          local: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
          importKind: 'value',
        },
      ],
      range: [40, 70],
    } as any;
    const mergeTarget = {
      type: AST_NODE_TYPES.ImportDeclaration,
      importKind: 'value',
      source: { value: './foo', raw: '"./foo"' },
      specifiers: [
        {
          type: AST_NODE_TYPES.ImportSpecifier,
          imported: { type: AST_NODE_TYPES.Identifier, name: 'Same' },
          local: { type: AST_NODE_TYPES.Identifier, name: 'Same' },
          importKind: 'value',
        },
        {
          type: AST_NODE_TYPES.ImportSpecifier,
          imported: { type: AST_NODE_TYPES.Identifier, name: 'Same' },
          local: { type: AST_NODE_TYPES.Identifier, name: 'Same' },
          importKind: 'type',
        },
      ],
      range: [0, 39],
    } as any;
    const sourceCode = {
      ast: {
        body: [mergeTarget, currentNode],
      },
      text: 'import { Bar as Same, Baz as Same } from "./foo";\nimport { Foo } from "./barrel";',
    } as any;

    const fix = __private__.buildAutofix(sourceCode, currentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: currentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Foo',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
      } as any,
    ]);

    expect(fix?.(createFixer() as any)).toBeNull();
  });

  it('covers positive autofix output with double quotes', () => {
    const code = 'import { Foo } from "./barrel";';
    const sourceCode = createSourceCode(code);
    const currentNode = sourceCode.ast.body[0] as any;
    const fix = __private__.buildAutofix(sourceCode, currentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: currentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Foo',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
      } as any,
    ]);

    expect(fix?.(createFixer() as any)).toEqual([
      { type: 'replaceText', range: [0, code.length], text: 'import { Foo } from "./foo";' },
    ]);
  });

  it('covers merge autofix output for value and type-only imports', () => {
    const valueCode = 'import { Existing } from "./foo";\nimport { Foo } from "./barrel";';
    const valueSourceCode = createSourceCode(valueCode);
    const valueCurrentNode = valueSourceCode.ast.body[1] as any;
    const valueFix = __private__.buildAutofix(valueSourceCode, valueCurrentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: valueCurrentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Foo',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: false,
          fromExportAll: false,
        },
      } as any,
    ]);

    expect(valueFix?.(createFixer() as any)).toEqual([
      {
        type: 'replaceText',
        range: valueSourceCode.ast.body[0].range,
        text: 'import { Existing, Foo } from "./foo";',
      },
      { type: 'removeRange', range: [valueCurrentNode.range[0], valueCode.length] },
    ]);

    const typeCode = "import type { Existing } from './foo';\nimport type { Foo } from './barrel';";
    const typeSourceCode = createSourceCode(typeCode);
    const typeCurrentNode = typeSourceCode.ast.body[1] as any;
    const typeFix = __private__.buildAutofix(typeSourceCode, typeCurrentNode, [
      {
        preferredSourceSpecifier: './foo',
        specifier: typeCurrentNode.specifiers[0],
        reExportTarget: {
          importedName: 'Foo',
          resolvedFilePath: '/tmp/foo.ts',
          sourceSpecifier: './foo',
          isTypeOnly: true,
          fromExportAll: false,
        },
      } as any,
    ]);

    expect(typeFix?.(createFixer() as any)).toEqual([
      {
        type: 'replaceText',
        range: typeSourceCode.ast.body[0].range,
        text: "import type { Existing, Foo } from './foo';",
      },
      { type: 'removeRange', range: [typeCurrentNode.range[0], typeCode.length] },
    ]);
  });

  it('covers the import visitor early-return branches with synthetic nodes', () => {
    const reports: unknown[] = [];
    const context = {
      filename: path.join(makeTempDir(), 'consumer.ts'),
      options: [{}],
      report: (descriptor: unknown) => reports.push(descriptor),
      sourceCode: {
        ast: { body: [] },
        text: '',
      },
    } as any;

    const visitor = preferSourceImports.create(context);

    visitor.ImportDeclaration?.({
      source: { value: null },
      specifiers: [],
    } as any);
    visitor.ImportDeclaration?.({
      source: { value: './missing', raw: "'./missing'" },
      specifiers: [
        {
          type: AST_NODE_TYPES.ImportSpecifier,
          imported: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
          local: { type: AST_NODE_TYPES.Identifier, name: 'Foo' },
        },
      ],
    } as any);

    expect(reports).toEqual([]);
  });
});
