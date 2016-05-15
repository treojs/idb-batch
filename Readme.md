# idb-batch

> Perform batch operation on IndexedDB

[![](https://saucelabs.com/browser-matrix/idb-batch.svg)](https://saucelabs.com/u/idb-batch)

[![](https://img.shields.io/npm/v/idb-batch.svg)](https://npmjs.org/package/idb-batch)
[![](https://img.shields.io/travis/treojs/idb-batch.svg)](https://travis-ci.org/treojs/idb-batch)
[![](http://img.shields.io/npm/dm/idb-batch.svg)](https://npmjs.org/package/idb-batch)

Create/update/remove objects from IndexedDB store in one transaction [without blocking the main thread](http://stackoverflow.com/questions/10471759/inserting-large-quantities-in-indexeddbs-objectstore-blocks-ui).
This module also manually validates unique indexes, fixing bugs in [WebKit](https://bugs.webkit.org/show_bug.cgi?id=149107)
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

### transactionalBatch(tr: IDBDatabase|IDBTransaction, storeOpsArr, opts = { parallel: false, extraStores: [], resolveEarly: false })

`transactionalBatch` allows you to make operations across multiple stores
within a single transaction.

You may pass in your own `IDBTransaction` as `tr` or just supply an
`IDBDatabase` object and let `transactionalBatch` iterate over your operations
to determine what store names should be part of the transaction.

`storeOpsArr` is an array whose items are either functions (which accept the
transaction shared by the batch as argument) or objects whose keys are store
names and whose values follow the Array or Object notation described under
the `ops` argument of `batch`. `storeOpsArr` can also be such a single object
keyed by store name (its results will be presented in the resolved Promise
as if the object had been supplied within a (single-item) array).

If you are using store-name-keyed objects within `storeOpsArr`, be aware
that iteration order may not be consistent within an object, even when
`parallel` is false (see below), so you may wish to limit yourself to one
store key per object and use more objects.

`transactionalBatch` returns a `Promise` which resolves with the results of
each request. The results will be an array containing a child array for each
child of `storeOpsArr`. Within those child arrays will be, when functions are
supplied, the return result or, when objects are supplied, an object whose
keys are store names and whose values are the array of results for each child
operation.

#### `transactionalBatch` option: `extraStores`: Array

If you are using functions which operate on store names not specified elsewhere
among the (Object-based) operations, you may add those store names to the
`extraStores` property to allow the transaction shared with the functions to
operate on those store names.

#### `transactionalBatch` option: `parallel`: Boolean

The default behavior is to conduct operations in series, waiting for each
operation to complete before proceeding to the next (including waiting for
promises to resolve if a function-based operation supplies them as its own
return value, noting however that there is some risk in doing so, especially
when chaining promises, in that the transaction of the batch may actually
complete (and its promise thus resolve) before the operation's promise
resolves). If your batch of operations does not need to occur in order,
you may instead set the `parallel` option to `true` which will load operations
in parallel, and will not wait for operations to complete before proceeding
to the next, nor will it wait for all operations pertaining to a given store
or function to complete before proceeding to the next set of operations.

#### `transactionalBatch` option: `resolveEarly`: Boolean

By default, the promise returned by `transactionalBatch` will only resolve
with its array of results collecting return values for each of the
operations will only be made available after the transaction completes.
Setting `resolveEarly` to `true` will allow the promise to resolve with
the results array before it may be fully populated but after it has begun
execution of all of the operations within the batch.

#### `transactionalBatch` option: `adapterCb`: Function

By default, any function-type operations will be supplied the transaction
and the return result will be added to the results.

`adapterCb` is an optional callback which will be supplied the transaction
as well as the currently iterated function-type operation. The return
result of this callback will be added to the results. This allows for
supplying additional or alternative arguments to the callback (as opposed to
just the transaction object).

### batch(db: IDBDatabase|IDBTransaction, storeName: String, ops: Array|Object, opts: { parallel: false, extraStores: [], resolveEarly: false })

This creates a `readwrite` transaction to `storeName`, and performs `ops`
sequentially. It returns a `Promise` which resolves with the results of
each request.

This function only operates on a single store; if you require operations across
multiple stores, use `transactionalBatch`. See `transactionalBatch` also for
a description of the properties that may be used on `opts`.

Although this function allows an `IDBTransaction` in place of `IDBDatabase`,
usually, it may be generally more convenient to just pass in `IDBDatabase` and
let `batch` build the transaction for you (by auto-detecting the store names
implicit in `ops`).

**Array notation** is inspired by [LevelUP](https://github.com/Level/levelup#batch).
Each operation is an object with 3 possible properties: `type`, `key`, `value`.
`type` is either `add`, `put`, `del`, `move`, `copy`, or `clear`, and `key` is
optional when the store has a `keyPath` and the supplied value contains it.
When `move` or `copy` is used, the `key` represents the new destination of
the operation and `value` represents the old key from which to move or copy.

```js
await batch(db, 'books', [
  { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
  { type: 'del', key: 2 }
  { type: 'put', value: { id: 3, name: 'M3', frequency: 24 } }, // no key
])
```

Note that `move` is composed of two operations, `copy` and `del`, and, at
present, does not function atomically, so if you set `parallel` to `true`,
there is a small chance that subsequent operations could occur after the
`copy` but before the `del` takes place (though the deleting will not take
place until a copy has been made).

At present, there are no options to allow `copy` or `move` to work across
stores or to involve sub-objects. You should instead use functions to conduct
such operations.

**Object notation** is sugar on top of array notation for `put`/`del`
operations. Set `key` to `null` in order to delete a value.

```js
await batch(db, 'storage', {
  key1: 'update value',
  key2: null, // delete value
  key3: 'new value',
})
```

### getStoreNames(storeOps: Array|Object)

Returns an array of the store names used in a set of store operations.
This function does not obtain store names used solely within function
operations. If you wish for a function operation to operate on additional
store names and as part of the same transaction, you should add the required
store names to the `extraStores` option of `transactionalBatch`.

### ConstraintError

If during sequential execution one of the operations throws a
`ConstraintError`, the `Promise` rejects with an error, but previous
successful operations will commit.
This behavior may change in future versions, as I figure out how to
properly abort transactions in `IndexedDBShim`.

## LICENSE

[MIT](./LICENSE)
