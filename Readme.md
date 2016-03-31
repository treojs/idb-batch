# idb-batch

> Perform batch operation on IndexedDB

[![](https://saucelabs.com/browser-matrix/idb-batch.svg)](https://saucelabs.com/u/idb-batch)

[![](https://img.shields.io/npm/v/idb-batch.svg)](https://npmjs.org/package/idb-batch)
[![](https://img.shields.io/travis/treojs/idb-batch.svg)](https://travis-ci.org/treojs/idb-batch)
[![](http://img.shields.io/npm/dm/idb-batch.svg)](https://npmjs.org/package/idb-batch)

Create/update/remove objects from IndexedDB store in one transaction [without blocking main tread](http://stackoverflow.com/questions/10471759/inserting-large-quantities-in-indexeddbs-objectstore-blocks-ui).
This module also manually validates unique indexes fixing bugs in [WebKit](https://bugs.webkit.org/show_bug.cgi?id=149107)
and [IndexedDBShim](https://github.com/axemclion/IndexedDBShim/issues/56).

## Example

Using [idb-factory](https://github.com/treojs/idb-factory) and [ES2016 async/await syntax](https://jakearchibald.com/2014/es7-async-functions/).
Check [test.js](./test/index.js) for more examples.

```js
import batch from 'idb-batch'
import { open } from 'idb-factory'

// open IndexedDB database with 2 stores
const db = await open('mydb', 1, upgradeCallback)

// modify object store
await batch(db, 'magazines', [
  { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
  { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
  { type: 'add', key: 3, value: { name: 'M3', frequency: 6 } },
  { type: 'del', key: 4 },
]).then((result) => {
  console.log(result) // [1, 2, 3, undefined]
}).catch((err) => {
  console.error(err)
})

function upgradeCallback(e) {
  e.target.result.createObjectStore('books', { keyPath: 'id' })  
  e.target.result.createObjectStore('magazines')  
}
```

### batch(db: IDBDatabase, storeName: String, ops: Array|Object)

It creates `readwrite` transaction to `storeName`,
and performs `ops` sequentially. It returns `Promise` which resolves with results of each request.

**Array notation** is inspired by [LevelUP](https://github.com/Level/levelup#batch).
Each operation is an object with 3 possible properties: `type`, `key`, `value`.
`type` is either `add`, `put`, or `del`, and `key` can be optional, when store has `keyPath` and value contains it.

```js
await batch(db, 'books', [
  { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
  { type: 'del', key: 2 }
  { type: 'put', value: { id: 3, name: 'M3', frequency: 24 } }, // no key
])
```

**Object notation** is a sugar on top of array notation for `put`/`del` operations.
Set `key` to `null` in order to delete value.

```js
await batch(db, 'storage', {
  key1: 'update value',
  key2: null, // delete value
  key3: 'new value',
})
```

### ConstraintError

If during sequential execution one of operations throws `ConstraintError`,
`Promise` rejects with error, but previous successful operations commit.
This behavior can change in future versions,
when I will figure out how to properly abort transaction in IndexedDBShim.

## LICENSE

[MIT](./LICENSE)
