import fs from 'node:fs';
import path from 'node:path';
import {
  AnalysisCaches,
  BarrelAnalysis,
  ManualAliasMapping,
  Options,
  ReExportTarget,
  ResolutionCaches,
  TsconfigInfo,
} from './types';
import { parseBarrelFile } from './analysis';
import {
  applyAliasTarget,
  buildAliasSpecifier,
  getOptionsCacheKey,
  isRelativePath,
  matchesAliasPattern,
  normalizeModulePath,
  resolveModuleFile,
  toRelativeImportSpecifier,
} from './path-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const typescript = require('typescript');

const tsconfigInfoCache = new Map<string, TsconfigInfo | null>();

export function createResolutionCaches(
  sharedTsconfigCache: Map<string, TsconfigInfo | null> = tsconfigInfoCache,
): ResolutionCaches {
  return {
    barrelAnalyses: new Map<string, BarrelAnalysis | null>(),
    importResolutions: new Map<string, string | null>(),
    tsconfigInfo: sharedTsconfigCache,
  };
}

export function getSharedTsconfigCache(): Map<string, TsconfigInfo | null> {
  return tsconfigInfoCache;
}

export function getTsconfigPath(
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

export function getTsconfigInfo(
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

export function resolveWithManualPaths(
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

export function getManualAliasMappings(options: Options[0] | undefined): Array<ManualAliasMapping> {
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

export function resolveWithTsconfig(
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

export function resolveImport(
  options: Options[0] | undefined,
  resolutionCaches: ResolutionCaches,
  importerFilename: string,
  specifier: string,
  cwd: string = process.cwd(),
): string | null {
  const cacheKey = `${getOptionsCacheKey(options, cwd)}\0${importerFilename}\0${specifier}`;
  const cachedResult = resolutionCaches.importResolutions.get(cacheKey);

  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const resolvedFilePath = isRelativePath(specifier)
    ? resolveModuleFile(importerFilename, specifier)
    : (resolveWithManualPaths(options, importerFilename, specifier, cwd) ??
      resolveWithTsconfig(options, importerFilename, specifier, resolutionCaches.tsconfigInfo, cwd));

  resolutionCaches.importResolutions.set(cacheKey, resolvedFilePath);

  return resolvedFilePath;
}

export function reverseResolveManualAlias(
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

export function reverseResolveTsconfigAlias(
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

export function getPreferredSourceSpecifier(
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

export function getBarrelAnalysis(
  options: Options[0] | undefined,
  barrelFilePath: string,
  barrelExportCache: Map<string, BarrelAnalysis | null>,
  resolutionCaches: ResolutionCaches,
  analysisCaches: AnalysisCaches,
  cwd: string = process.cwd(),
): BarrelAnalysis | null {
  const cacheKey = `${getOptionsCacheKey(options, cwd)}\0${barrelFilePath}`;
  const cachedAnalysis = barrelExportCache.get(cacheKey);

  if (cachedAnalysis !== undefined) {
    return cachedAnalysis;
  }

  let barrelAnalysis = resolutionCaches.barrelAnalyses.get(cacheKey);

  if (!resolutionCaches.barrelAnalyses.has(cacheKey)) {
    barrelAnalysis = parseBarrelFile(
      barrelFilePath,
      (importerFilename, specifier) => resolveImport(options, resolutionCaches, importerFilename, specifier, cwd),
      analysisCaches,
    );
    resolutionCaches.barrelAnalyses.set(cacheKey, barrelAnalysis);
  }

  barrelExportCache.set(cacheKey, barrelAnalysis ?? null);

  return barrelAnalysis ?? null;
}
