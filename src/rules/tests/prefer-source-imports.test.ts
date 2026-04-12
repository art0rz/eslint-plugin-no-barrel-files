import path from 'node:path';
import { RuleTester } from '@typescript-eslint/rule-tester';
import preferSourceImports from '../prefer-source-imports';

const ruleTester = new RuleTester();
const fixtureDirectory = path.join(process.cwd(), 'src/rules/tests/fixtures/prefer-source-imports');

ruleTester.run('prefer-source-imports', preferSourceImports, {
  valid: [
    {
      code: `import { Foo } from './foo';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
    },
    {
      code: `import DefaultThing from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
    },
    {
      code: `import { Missing } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
    },
  ],
  invalid: [
    {
      code: `import { Foo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo } from './foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Baz } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Bar as Baz } from './bar';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { DefaultThing } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { default as DefaultThing } from './default-thing';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo, Baz } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo } from './foo';\nimport { Bar as Baz } from './bar';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Existing } from './foo';\nimport { Foo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Existing, Foo } from './foo';\n`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo as LocalFoo } from './foo';\nimport { Foo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo as LocalFoo, Foo } from './foo';\n`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo, Missing } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import type { TypeFoo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import type { TypeFoo } from './types';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { type TypeFoo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import type { TypeFoo } from './types';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo, type TypeFoo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo } from './foo';\nimport type { TypeFoo } from './types';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import type { TypeFoo, Missing } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import { type TypeFoo, Missing } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import DefaultThing, { Foo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import { StarFoo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { StarFoo } from './star';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo, StarFoo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo } from './foo';\nimport { StarFoo } from './star';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Foo } from '@app/foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { StarFoo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { StarFoo } from '@app/star';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from '@manual/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          tsconfig: false,
          paths: {
            '@manual/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
          },
        },
      ],
      output: `import { Foo } from '@manual/foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from '@manual/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'relative',
          tsconfig: false,
          paths: {
            '@manual/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
          },
        },
      ],
      output: `import { Foo } from './foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Existing } from '@app/foo';\nimport { Foo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import { Existing, Foo } from '@app/foo';\n`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { type TypeFoo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      output: `import type { TypeFoo } from '@app/types';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from './barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'preserve-alias',
          tsconfig: false,
        },
      ],
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import { Foo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'preserve-alias',
        },
      ],
      output: `import { Foo } from '@app/foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'preserve-alias',
          tsconfig: false,
          paths: {
            '@app/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
            '@dup-a/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
          },
        },
      ],
      errors: [{ messageId: 'preferSourceImport' }],
    },
    {
      code: `import { Foo } from '@app/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'auto',
          tsconfig: false,
          paths: {
            '@app/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
            '@dup-a/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
          },
        },
      ],
      output: `import { Foo } from './foo';`,
      errors: [{ messageId: 'preferSourceImports' }],
    },
    {
      code: `import { Foo } from '@manual/barrel';`,
      filename: path.join(fixtureDirectory, 'consumer.ts'),
      options: [
        {
          fixStyle: 'preserve-alias',
          tsconfig: false,
          paths: {
            '@dup-a/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
            '@dup-b/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
            '@manual/*': 'src/rules/tests/fixtures/prefer-source-imports/*',
          },
        },
      ],
      errors: [{ messageId: 'preferSourceImport' }],
    },
  ],
});
