import { RuleTester } from '@typescript-eslint/rule-tester';
import myRule from '../no-barrel-files';

const ruleTester = new RuleTester({
  parser: '@typescript-eslint/parser',
});

ruleTester.run('no-barrel-files', myRule, {
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
      code: `
      import Foo from "./foo";
      import Bar from "./bar";
      export default Foo;
      export { Bar };
      `,
      errors: [{ messageId: 'noReExport' }, { messageId: 'noReExport' }],
    },
  ],
});
