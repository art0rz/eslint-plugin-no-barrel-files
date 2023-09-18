# eslint-plugin-no-barrel-files
ESLint plugin to disallow [barrel files](https://github.com/basarat/typescript-book/blob/master/docs/tips/barrel.md).

## Why?
Barrel files can slow down your build/tests, can cause circular dependencies, and makes tree shaking more difficult.

- https://github.com/jestjs/jest/issues/11234
- https://github.com/vercel/next.js/issues/12557
- https://dev.to/tassiofront/barrel-files-and-why-you-should-stop-using-them-now-bc4
- https://flaming.codes/posts/barrel-files-in-javascript

## Rules
- `no-barrel-files`
```js
// fail
export * from "./foo";

import Foo from "./foo";
export default Foo;

import Foo from "./foo";
export { Foo };

export { Moo } from './Moo';
export { default as Moo } from './Moo';

// pass
const Foo = 'baz';
function Bar() {}
class Baz {}

export default Foo;
export { Bar, Baz }

import { Moo } from './Moo';
export const Baz = Moo;
```

## Usage

### Install
```shell
npm i eslint-plugin-no-barrel-files --dev
```

### ESLint config
```js
module.exports = {
    plugins: ['no-barrel-files'],
    rules: {
        'no-barrel-files/no-barrel-files': 'error'
    }
}
```

## Contributing
If you need any additional features or you find a bug, feel free to submit a pull request or submit an issue.

