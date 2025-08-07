import { RuleTester } from '@typescript-eslint/rule-tester';
import noImportsFromReExports from '../no-imports-from-re-exports';
import * as path from 'path';

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
    }
});

const fixturesDir = path.resolve(__dirname, 'fixtures');

ruleTester.run('no-imports-from-re-exports', noImportsFromReExports, {
  valid: [
    {
      code: `import { Button } from './components/button';`,
      filename: path.join(fixturesDir, 'app.ts'),
    },
    {
      code: `import Card from './components/card';`,
      filename: path.join(fixturesDir, 'app.ts'),
    },
  ],
  invalid: [
    {
      code: `import { Button } from './components';`,
      filename: path.join(fixturesDir, 'app.ts'),
      errors: [{ messageId: 'noImportFromReExport' }],
      output: `import { Button } from './components/button';`,
    },
    {
        code: `import { Button } from '@/components';`,
        filename: path.join(fixturesDir, 'app.ts'),
        options: [{ aliases: { '@': fixturesDir } }],
        errors: [{ messageId: 'noImportFromReExport' }],
        output: `import { Button } from './components/button';`,
    },
    {
        code: `import Card from './components';`,
        filename: path.join(fixturesDir, 'app-default.ts'),
        errors: [{ messageId: 'noImportFromReExport' }],
        output: `import Card from './components/card';`,
    },
    {
        code: `import { Button } from './components/all';`,
        filename: path.join(fixturesDir, 'app-all.ts'),
        errors: [{ messageId: 'noImportFromReExport' }],
        output: `import { Button } from './components/button';`,
    },
    {
        code: `import { MyButton } from './components/renamed';`,
        filename: path.join(fixturesDir, 'app-renamed.ts'),
        errors: [{ messageId: 'noImportFromReExport' }],
        output: `import { MyButton } from './components/button';`,
    },
    {
        code: `import { ns } from './components/namespace';`,
        filename: path.join(fixturesDir, 'app-namespace.ts'),
        errors: [{ messageId: 'noImportFromReExport' }],
        output: `import * as ns from './components/button';`,
    }
  ],
});
