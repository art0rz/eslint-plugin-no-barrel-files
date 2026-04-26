# eslint-plugin-no-barrel-files

ESLint plugin for reducing barrel-file usage in two ways:

- `no-barrel-files`: disallow authoring barrel files
- `prefer-source-imports`: prefer importing from source modules instead of through a barrel

The plugin is useful both for strict greenfield setups and for incremental migrations away from existing barrels.

## Why?

Barrel files can:

- slow down builds and tests
- make circular dependencies easier to introduce
- make tree shaking less effective
- blur module boundaries and make import paths less explicit

References:

- https://github.com/jestjs/jest/issues/11234
- https://github.com/vercel/next.js/issues/12557
- https://dev.to/tassiofront/barrel-files-and-why-you-should-stop-using-them-now-bc4
- https://flaming.codes/posts/barrel-files-in-javascript

## Install

```sh
npm install --save-dev eslint-plugin-no-barrel-files
```

If you plan to use `prefer-source-imports` with TypeScript files or tsconfig-based path resolution, also install `typescript` in the consuming project. The rule uses your project's TypeScript resolver so it can follow `tsconfig.json`, `baseUrl`, and `paths` consistently with the codebase being linted.

```sh
npm install --save-dev typescript
```

## Quick Start

This plugin supports:

- ESLint 9+ and 10+ via flat config
- ESLint 8 via legacy config

### Flat Config

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

export default [
  ...noBarrelFiles.configs.recommended,
  {
    rules: {
      'no-barrel-files/prefer-source-imports': 'error',
    },
  },
];
```

### Legacy Config

```js
module.exports = {
  plugins: ['no-barrel-files'],
  rules: {
    'no-barrel-files/no-barrel-files': 'error',
    'no-barrel-files/prefer-source-imports': 'error',
  },
};
```

## Included Configs

The plugin exports:

- `configs.recommended`
- `configs["flat/recommended"]`
- `configs["legacy-recommended"]`
- `flat`

The recommended configs currently enable only `no-barrel-files`.

That is intentional:

- `no-barrel-files` is safe to adopt immediately if you want to block new barrels
- `prefer-source-imports` is more migration-oriented, so it stays opt-in

## Rules

### `no-barrel-files`

Disallows common barrel-file patterns such as re-exporting imported bindings or using `export *`.

```js
// fail
export * from "./foo";

import Foo from "./foo";
export default Foo;

import Foo from "./foo";
export { Foo };

export { Moo } from "./Moo";
export { default as Moo } from "./Moo";

// pass
const Foo = "baz";
function Bar() {}
class Baz {}

export default Foo;
export { Bar, Baz };

import { Moo } from "./Moo";
export const Baz = Moo;
```

Use this rule when you want to stop new barrel files from being created.

### `prefer-source-imports`

Reports imports that go through a barrel when the rule can resolve the original source module.

```ts
// fail
import { Foo } from './barrel';
import type { TypeFoo } from './barrel';

// if barrel.ts contains:
// export { Foo } from "./foo";
// export type { TypeFoo } from "./types";

// pass
import { Foo } from './foo';
import type { TypeFoo } from './types';
```

This rule is useful when:

- a codebase still has barrel files
- you want to migrate consumers away from barrels gradually
- you want autofixable guidance where possible

#### What it can resolve

`prefer-source-imports` currently supports:

- relative imports
- TypeScript `baseUrl` and `paths` from the nearest `tsconfig.json`
- explicit alias mappings through the `paths` rule option
- explicit re-exports such as `export { Foo } from "./foo"`
- aliased re-exports such as `export { Bar as Foo } from "./bar"`
- default re-exports such as `export { default as Foo } from "./foo"`
- `export * from "./foo"` when the exported name can be resolved back to the source file
- type-only re-exports such as `export type { Foo } ...` and `export { type Foo } ...`

Current scope:

- the rule focuses on named imports
- default imports from a barrel are not rewritten
- namespace imports are not the target of this rule

#### Safe autofix behavior

The rule only autofixes when the full import declaration can be rewritten safely.

If only part of an import can be resolved safely, the rule still reports the problem but may skip autofix.

## `prefer-source-imports` Options

### `fixStyle`

Controls how the replacement import path is generated.

- `"relative"`
  Always rewrites to a relative import path.
- `"preserve-alias"`
  Preserves an alias only when the reverse alias mapping is unique.
- `"auto"`
  Preserves aliases for alias-based imports when the reverse alias mapping is unique; otherwise falls back to a relative path.

### `tsconfig`

Controls tsconfig-based path resolution.

- omitted or `true`
  Use the nearest `tsconfig.json`.
- `false`
  Disable tsconfig-based resolution entirely.
- `"./path/to/tsconfig.json"`
  Resolve using a specific config file.

### `paths`

Manual alias mappings that supplement or replace tsconfig path resolution.

Values can be:

- a string
- an array of strings

Example:

```js
{
  paths: {
    "@app/*": "src/*",
    "@shared/*": ["packages/shared/src/*", "src/shared/*"],
  },
}
```

## Configuration Examples

### Use The Recommended Config Only

This blocks new barrel files, but does not yet enforce direct source imports.

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

export default [...noBarrelFiles.configs.recommended];
```

### Enable Both Rules

This is a good migration setup.

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

export default [
  ...noBarrelFiles.configs.recommended,
  {
    rules: {
      'no-barrel-files/prefer-source-imports': 'error',
    },
  },
];
```

### Use Manual Alias Resolution Only

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

export default [
  {
    plugins: {
      'no-barrel-files': noBarrelFiles,
    },
    rules: {
      'no-barrel-files/prefer-source-imports': [
        'error',
        {
          tsconfig: false,
          fixStyle: 'preserve-alias',
          paths: {
            '@app/*': 'src/*',
          },
        },
      ],
    },
  },
];
```

### Use A Specific `tsconfig.json`

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

export default [
  {
    plugins: {
      'no-barrel-files': noBarrelFiles,
    },
    rules: {
      'no-barrel-files/prefer-source-imports': [
        'error',
        {
          tsconfig: './tsconfig.eslint.json',
          fixStyle: 'auto',
        },
      ],
    },
  },
];
```

## Adoption Strategy

Typical rollout options:

- Start with `no-barrel-files` only to block new barrels.
- Add `prefer-source-imports` later to migrate consumers away from old barrels.
- Run `prefer-source-imports` first if the codebase already has many barrels and you want to shrink their usage before deleting them.

## Notes

- `prefer-source-imports` depends on being able to resolve the barrel and the underlying source module.
- `prefer-source-imports` uses the consuming project's `typescript` installation for tsconfig parsing and module resolution.
- If `prefer-source-imports` runs on a TypeScript file without `typescript` installed and tsconfig resolution is enabled, the rule reports a configuration error instead of crashing the plugin.
- Alias preservation only happens when reverse alias lookup is unique.
- If multiple aliases point to the same file, the fixer may fall back to a relative path or skip autofix depending on `fixStyle`.
- The plugin does not currently ship a recommended config that enables both rules by default.

## Contributing

If you find a bug or want an additional feature, open an issue or send a pull request.
