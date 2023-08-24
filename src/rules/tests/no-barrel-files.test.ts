import { RuleTester } from '@typescript-eslint/rule-tester';
import myRule from "../no-barrel-files";

const ruleTester = new RuleTester({
	parser: '@typescript-eslint/parser'
});

ruleTester.run('my-rule', myRule, {
	valid: ['notFooBar()', 'const foo = 2', 'const bar = 2'],
	invalid: [
		{
			code: 'foo()',
			errors: [{ messageId: 'messageIdForSomeFailure' }],
		},
		{
			code: 'bar()',
			errors: [{ messageId: 'messageIdForSomeOtherFailure' }],
		},
	],
});