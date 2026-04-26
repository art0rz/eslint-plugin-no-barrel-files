import { TSESTree } from '@typescript-eslint/utils';

export type MessageIds = 'preferSourceImport' | 'preferSourceImports';

export type Options = [
  {
    fixStyle?: 'auto' | 'preserve-alias' | 'relative';
    paths?: Record<string, string | string[]>;
    tsconfig?: boolean | string;
  }?,
];

export type ReExportTarget = {
  importedName: string;
  resolvedFilePath: string;
  sourceSpecifier: string;
  isTypeOnly: boolean;
  fromExportAll: boolean;
};

export type NamedImportSpecifier = TSESTree.ImportSpecifier & {
  imported: TSESTree.Identifier;
  local: TSESTree.Identifier;
};

export type MatchedSpecifier = {
  preferredSourceSpecifier: string | null;
  specifier: NamedImportSpecifier;
  reExportTarget: ReExportTarget;
};

export type BarrelAnalysis = {
  explicitReExports: Map<string, ReExportTarget>;
  exportAllReExports: Map<string, ReExportTarget>;
};

export type AnalysisCaches = {
  exportedBindings: Map<string, Set<string>>;
  parsedModules: Map<string, TSESTree.Program | null>;
};

export type TsconfigInfo = {
  compilerOptions: Record<string, unknown>;
  configFilePath: string;
};

export type ResolutionCaches = {
  barrelAnalyses: Map<string, BarrelAnalysis | null>;
  importResolutions: Map<string, string | null>;
  tsconfigInfo: Map<string, TsconfigInfo | null>;
};

export type ManualAliasMapping = {
  pattern: string;
  target: string;
};
