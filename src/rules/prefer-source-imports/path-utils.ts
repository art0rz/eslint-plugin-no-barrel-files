import fs from 'node:fs';
import path from 'node:path';
import { Options } from './types';

const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;
// TypeScript resolves an import written with a JS extension to the TS file that compiles to it.
const JS_TO_TS_EXTENSIONS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const TS_TO_JS_EXTENSIONS: Record<string, string> = {
  '.ts': '.js',
  '.tsx': '.js',
  '.mts': '.mjs',
  '.cts': '.cjs',
};
const moduleFileResolutionCache = new Map<string, string | null>();

export function getOptionsCacheKey(options: Options[0] | undefined, cwd: string): string {
  return JSON.stringify({
    cwd,
    options: options ?? {},
  });
}

export function isRelativePath(value: string): boolean {
  return value.startsWith('.');
}

export function hasSourceFileExtension(specifier: string): boolean {
  return SOURCE_FILE_EXTENSIONS.some(extension => specifier.endsWith(extension));
}

export function resolveModuleFile(importerFilename: string, specifier: string): string | null {
  const cacheKey = `${importerFilename}\0${specifier}`;
  const cachedResult = moduleFileResolutionCache.get(cacheKey);

  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const resolvedBase = path.resolve(path.dirname(importerFilename), specifier);
  const specifierExtension = path.extname(resolvedBase);
  const candidatePaths = [
    resolvedBase,
    ...(JS_TO_TS_EXTENSIONS[specifierExtension] ?? []).map(
      extension => `${resolvedBase.slice(0, -specifierExtension.length)}${extension}`,
    ),
    ...SOURCE_FILE_EXTENSIONS.map(extension => `${resolvedBase}${extension}`),
    ...SOURCE_FILE_EXTENSIONS.map(extension => path.join(resolvedBase, `index${extension}`)),
  ];

  const resolvedFilePath =
    candidatePaths.find(candidatePath => fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) ?? null;

  moduleFileResolutionCache.set(cacheKey, resolvedFilePath);

  return resolvedFilePath;
}

export function normalizeModulePath(filePath: string): string {
  const normalizedPath = filePath.split(path.sep).join('/');

  return normalizedPath.replace(/\/index(?=(\.[^./]+)?$)/, '').replace(/\.[^./]+$/, '');
}

export function toRelativeImportSpecifier(importerFilename: string, resolvedFilePath: string): string {
  const relativePath = path.relative(path.dirname(importerFilename), resolvedFilePath);
  const normalizedPath = normalizeModulePath(relativePath);

  return normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`;
}

/**
 * Builds a relative specifier that keeps the extension style of `originalSpecifier`, for projects that require
 * explicit extensions. A `.js`-style specifier gets the JS extension a TS file compiles to; a `.ts`-style specifier
 * keeps the real extension.
 */
export function toRelativeImportSpecifierWithExtension(
  importerFilename: string,
  resolvedFilePath: string,
  originalSpecifier: string,
): string {
  const relativePath = path.relative(path.dirname(importerFilename), resolvedFilePath).split(path.sep).join('/');
  const resolvedExtension = path.extname(resolvedFilePath);
  const usesTypeScriptExtension = path.extname(originalSpecifier) in TS_TO_JS_EXTENSIONS;
  const outputExtension = usesTypeScriptExtension
    ? resolvedExtension
    : (TS_TO_JS_EXTENSIONS[resolvedExtension] ?? resolvedExtension);
  const withoutExtension = relativePath.slice(0, relativePath.length - resolvedExtension.length);
  const specifier = `${withoutExtension}${outputExtension}`;

  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

export function matchesAliasPattern(specifier: string, pattern: string): string | null {
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

export function applyAliasTarget(target: string, wildcardValue: string): string {
  return target.includes('*') ? target.replace('*', wildcardValue) : target;
}

export function buildAliasSpecifier(pattern: string, wildcardValue: string): string {
  return pattern.includes('*') ? pattern.replace('*', wildcardValue) : pattern;
}
