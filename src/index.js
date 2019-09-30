import isPlainObj from 'is-plain-obj'
import isSafari from 'is-safari'

/**
 * Links to array prototype methods.
 */

const slice = [].slice
const map = [].map

/**
 * Perform batch operation for a single object store using `ops`.
 *
 * Array syntax:
 *
 * [
 *   { type: 'add', key: 'key1', val: 'val1' },
 *   { type: 'put', key: 'key2', val: 'val2' },
 *   { type: 'del', key: 'key3' },
 * ]
 *
 * Object syntax:
 *
 * {
 *   key1: 'val1', // put val1 to key1
 *   key2: 'val2', // put val2 to key2
 *   key3: null,   // delete key
 * }
 *
 * @param {Array|Object} ops Operations
 * @param {Object} opts See `transactionalBatch`
 * @return {Promise} Resolves to the result of the operations
 */

export default function batch (db, storeName, ops, opts) {
  if (typeof storeName !== 'string') return Promise.reject(new TypeError('invalid "storeName"'))
  if (![3, 4].includes(arguments.length)) return Promise.reject(new TypeError('invalid arguments length'))
  try {
    validateAndCanonicalizeOps(ops)
  } catch (err) {
    return Promise.reject(err)
  }
  return transactionalBatch(db, { [storeName]: ops }, opts).then((arr) => arr[0][storeName])
}

export function getStoreNames (storeOpsArr) {
  if (isPlainObj(storeOpsArr)) storeOpsArr = [storeOpsArr]
  return storeOpsArr.reduce((storeNames, opObj) => {
    // This has no effect if the opObj is a function
    return storeNames.concat(Object.keys(opObj))
  }, [])
}

/**
 * Perform batch operations for any number of object stores using `ops`.
 *
 * Array syntax:
 *
 * [
 *   { type: 'add', key: 'key1', val: 'val1' },
 *   { type: 'put', key: 'key2', val: 'val2' },
 *   { type: 'del', key: 'key3' },
 * ]
 *
 * Object syntax:
 *
 * {
 *   key1: 'val1', // put val1 to key1
 *   key2: 'val2', // put val2 to key2
 *   key3: null,   // delete key
 * }
 *
 * @param {IDBDatabase|IDBTransaction} tr IndexedDB database or transaction on which the batch will operate
 * @param {Array|Object} storeOpsArr Array of objects (or a single object) whose keys are store names and objects are idb-batch operations (object or array)
 * @param {Object} [opts] Options object
 * @property {Boolean} [opts.parallel=false] Whether or not to load in parallel
 * @property {Boolean} [opts.resolveEarly=false] Whether or not to resolve the promise before the transaction ends
 * @property {Array} [opts.extraStores=[]] A list of store names to add to the transaction (when `tr` is an `IDBDatabase` object)
 * @property {Function} [opts.adapterCb=null] A callback which will be supplied the `tr` and function of a function-type operation)
 * @return {Promise} Resolves to an array containing the results of the operations for each store
 */

export function transactionalBatch (tr, storeOpsArr, opts = { parallel: false, extraStores: [], resolveEarly: false, adapterCb: null }) {
  if (![2, 3].includes(arguments.length)) return Promise.reject(new TypeError('invalid arguments length'))
  if (isPlainObj(storeOpsArr)) storeOpsArr = [storeOpsArr]
  const storeOpsArrIter = storeOpsArr.keys()
  opts = opts || {}
  if (typeof tr.createObjectStore === 'function') {
    tr = tr.transaction(getStoreNames(storeOpsArr).concat(opts.extraStores || []), 'readwrite')
  }
  return new Promise((resolve, reject) => {
    const results = []
    tr.addEventListener('error', handleError(reject))
    tr.addEventListener('abort', handleError(reject))
    if (!opts.resolveEarly) tr.addEventListener('complete', () => resolve(results))

    const iterateStores = (ct, storeResults, storeNames, storeOpsKeys, storeOpsObj, serial) => {
      if (typeof storeOpsObj === 'function') {
        let ret
        try {
          ret = opts.adapterCb ? opts.adapterCb(tr, storeOpsObj) : storeOpsObj(tr)
        } catch (err) {
          reject(err)
          return
        }
        results[ct] = ret
        if (serial) {
          if (ret && ret.then) {
            ret.then(iterateStoreOps)
            return
          }
          iterateStoreOps()
        }
        return
      }
      const storeOpIter = storeOpsKeys.next()
      if (storeOpIter.done) {
        if (serial) iterateStoreOps()
        return
      }
      const idx = storeOpIter.value
      const storeName = storeNames[idx]
      let moveCt = 0
      let successCt = 0

      let ops = storeOpsObj[storeName]
      try {
        ops = validateAndCanonicalizeOps(ops)
      } catch (err) {
        reject(err)
        return
      }

      const store = tr.objectStore(storeName)

      if (serial) {
        next(ct, 0)
      } else {
        for (let i = 0; i < ops.length; i++) {
          next(ct, i)
        }
        iterateStores(ct, storeResults, storeNames, storeOpsKeys, storeOpsObj)
      }

      function next (storeOpsIdx, opIndex) {
        const { type, key } = ops[opIndex]
        if (type === 'clear') {
          request(storeOpsIdx, opIndex, storeName, store.clear())
          return
        }
        if (type === 'del') {
          request(storeOpsIdx, opIndex, storeName, store.delete(key))
          return
        }
        const val = ops[opIndex].val || ops[opIndex].value
        if (['move', 'copy'].includes(type)) {
          const req = store.get(val)
          req.onerror = handleError(reject)
          req.onsuccess = (e) => {
            ops.splice(opIndex, 1, { type: 'put', key, value: e.target.result })
            if (type === 'move') {
              if (!serial) moveCt++
              ops.splice(opIndex + 1, 0, { type: 'del', key: val })
            }
            next(storeOpsIdx, opIndex)
            if (!serial && type === 'move') next(storeOpsIdx, opIndex + 1)
          }
          return
        }
        if (key && store.keyPath) val[store.keyPath] = key

        countUniqueIndexes(store, key, val, (err, uniqueRecordsCounter) => {
          if (err) return reject(err)

          // We don't abort transaction here (we just stop execution)
          // Browsers' implementations also don't abort, and instead just throw an error
          if (uniqueRecordsCounter) return reject(new Error('Unique index ConstraintError'))
          request(storeOpsIdx, opIndex, storeName, store.keyPath ? store[type](val) : store[type](val, key))
        })
      }

      function request (storeOpsIdx, opIndex, storeNm, req) {
        req.onerror = handleError(reject)
        req.onsuccess = (e) => {
          if (!storeResults[storeNm]) {
            storeResults[storeNm] = []
          }
          storeResults[storeNm][successCt++] = e.target.result
          if (successCt === ops.length - moveCt) {
            results[storeOpsIdx] = storeResults
            if (serial) iterateStores(ct, storeResults, storeNames, storeOpsKeys, storeOpsObj, serial)
          } else if (serial) {
            next(storeOpsIdx, ++opIndex)
          }
        }
      }
    }

    const iterateStoreOps = opts.parallel ? () => {
      for (let storeOpsObj = storeOpsArrIter.next(); !storeOpsObj.done; storeOpsObj = storeOpsArrIter.next()) {
        const val = storeOpsObj.value
        storeOpsObj = storeOpsArr[val]
        const storeNames = Object.keys(storeOpsObj)
        const storeOpsKeys = storeNames.keys()
        iterateStores(val, {}, storeNames, storeOpsKeys, storeOpsObj)
      }
      if (opts.resolveEarly) resolve(results)
    } : () => {
      let storeOpsObj = storeOpsArrIter.next()
      if (storeOpsObj.done) {
        if (opts.resolveEarly) resolve(results)
        return
      }
      const val = storeOpsObj.value
      storeOpsObj = storeOpsArr[val]
      const storeNames = Object.keys(storeOpsObj)
      const storeOpsKeys = storeNames.keys()
      iterateStores(val, {}, storeNames, storeOpsKeys, storeOpsObj, true)
    }
    iterateStoreOps()
  })
}

/**
 * Validate unique index manually.
 *
 * Fixing:
 * - https://bugs.webkit.org/show_bug.cgi?id=149107
 * - https://github.com/axemclion/IndexedDBShim/issues/56
 *
 * @param {IDBStore} store
 * @param {Any} val
 * @param {Function} cb(err, uniqueRecordsCounter)
 */

function countUniqueIndexes (store, key, val, cb) {
  // rely on native support
  if (!isSafari && global.indexedDB !== global.shimIndexedDB) return cb()

  const indexes = slice.call(store.indexNames).map((indexName) => {
    const index = store.index(indexName)
    const indexVal = isCompound(index)
      ? map.call(index.keyPath, (indexKey) => val[indexKey]).filter((v) => v)
      : val[index.keyPath]

    return [index, indexVal]
  }).filter(([index, indexVal]) => {
    return index.unique && (isCompound(index) ? indexVal.length : indexVal)
  })

  if (!indexes.length) return cb()

  let totalRequestsCounter = indexes.length
  let uniqueRecordsCounter = 0

  indexes.forEach(([index, indexVal]) => {
    const req = index.getKey(indexVal) // get primaryKey to compare with updating value
    req.onerror = handleError(cb)
    req.onsuccess = (e) => {
      if (e.target.result && e.target.result !== key) uniqueRecordsCounter++
      totalRequestsCounter--
      if (totalRequestsCounter === 0) cb(null, uniqueRecordsCounter)
    }
  })
}

/**
 * Check if `index` is compound
 *
 * @param {IDBIndex} index
 * @return {Boolean}
 */

function isCompound (index) {
  return typeof index.keyPath !== 'string'
}

/**
 * Create error handler.
 *
 * @param {Function} cb
 * @return {Function}
 */

function handleError (cb) {
  return (e) => {
    // prevent global error throw https://bugzilla.mozilla.org/show_bug.cgi?id=872873
    if (typeof e.preventDefault === 'function') e.preventDefault()
    cb(e.target.error)
  }
}

/**
 * Validate operations and canonicalize them into an array.
 *
 * @param {Array|Object} ops
 * @return {Array} Canonicalized operations array
 */

function validateAndCanonicalizeOps (ops) {
  if (ops === 'clear') {
    ops = [{ type: 'clear' }]
  }
  if (!Array.isArray(ops) && !isPlainObj(ops)) {
    throw new TypeError('invalid "ops"')
  }
  if (isPlainObj(ops)) {
    ops = Object.keys(ops).map((key) => {
      return { key, value: typeof ops[key] === 'string' ? ops[key].replace(/^\0/, '') : ops[key], type: ops[key] === '\0' ? 'del' : 'put' }
    })
  }
  function checkOp (op) {
    if (['add', 'put', 'del', 'move', 'copy', 'clear'].indexOf(op.type) === -1) throw new TypeError(`invalid type "${op.type}"`)
  }
  ops.forEach((op, i) => {
    if (!isPlainObj(op)) throw new TypeError('invalid op')
    const opKeys = Object.keys(op)
    const type = opKeys[0]
    if (opKeys.length === 1 && type !== 'type') {
      op = op[type]
      const opers = Array.isArray(op) ? op : [op]
      ops.splice(i, 1, ...(opers.map((oper) => {
        Object.assign(oper, { type })
        checkOp(oper)
        return oper
      })))
      return
    }
    checkOp(op)
  })
  return ops
}
