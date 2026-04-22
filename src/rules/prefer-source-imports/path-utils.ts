import fs from 'node:fs';
import path from 'node:path';
import { Options } from './types';

const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;
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

export function resolveModuleFile(importerFilename: string, specifier: string): string | null {
  const cacheKey = `${importerFilename}\0${specifier}`;
  const cachedResult = moduleFileResolutionCache.get(cacheKey);

  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const resolvedBase = path.resolve(path.dirname(importerFilename), specifier);
  const candidatePaths = [
    resolvedBase,
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
