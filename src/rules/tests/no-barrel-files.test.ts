import { RuleTester } from '@typescript-eslint/rule-tester';
import noBarrelFiles from '../no-barrel-files';

const ruleTester = new RuleTester({
  parser: '@typescript-eslint/parser',
});

ruleTester.run('no-barrel-files', noBarrelFiles, {
  valid: [
    `
      const Foo = 'baz';
      function Bar() {}
      class Baz {}
      
      export default Foo;
      export { Bar, Baz }
`,
  ],
  invalid: [
    {
      code: 'export * from "./foo"',
      errors: [{ messageId: 'noExportAll' }],
    },
    {
      code: 'export * as Foo from "./foo"',
      errors: [{ messageId: 'noExportAll' }],
    },
    {
      code: `
      import Foo from "./foo";
      export default Foo;
      `,
      errors: [{ messageId: 'noReExport' }],
    },
    {
      code: `
      import Foo from "./foo";
      export { Foo };
      `,
      errors: [{ messageId: 'noReExport' }],
    },
    {
      code: `
      export { Moo } from './Moo';
      `,
      errors: [{ messageId: 'noReExport' }],
    },
    {
      code: `
      export { default as Moo } from './Moo';
      `,
      errors: [{ messageId: 'noReExport' }],
    },
  ],
});
