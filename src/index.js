import isPlainObj from 'is-plain-obj'
import isSafari from 'is-safari'

/**
 * Links to array prototype methods.
 */

const slice = [].slice
const map = [].map

/**
 * Perform batch operation using `ops`.
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
 * 	 key1: 'val1', // put val1 to key1
 * 	 key2: 'val2', // put val2 to key2
 * 	 key3: null,   // delete key
 * }
 *
 * @param {Array|Object} ops
 * @return {Promise}
 */

export default function batch(db, storeName, ops) {
  if (arguments.length !== 3) throw new TypeError('invalid arguments length')
  if (typeof storeName !== 'string') throw new TypeError('invalid "storeName"')
  if (!Array.isArray(ops) && !isPlainObj(ops)) throw new TypeError('invalid "ops"')
  if (isPlainObj(ops)) {
    ops = Object.keys(ops).map((key) => {
      return { key, value: ops[key], type: ops[key] === null ? 'del' : 'put' }
    })
  }
  ops.forEach((op) => {
    if (!isPlainObj(op)) throw new TypeError('invalid op')
    if (['add', 'put', 'del'].indexOf(op.type) === -1) throw new TypeError(`invalid type "${op.type}"`)
  })

  return new Promise((resolve, reject) => {
    const tr = db.transaction(storeName, 'readwrite')
    const store = tr.objectStore(storeName)
    const results = []
    let currentIndex = 0

    tr.onerror = handleError(reject)
    tr.oncomplete = () => resolve(results)
    next()

    function next() {
      const { type, key } = ops[currentIndex]
      if (type === 'del') return request(store.delete(key))

      const val = ops[currentIndex].val || ops[currentIndex].value
      if (key && store.keyPath) val[store.keyPath] = key

      countUniqueIndexes(store, key, val, (err, uniqueRecordsCounter) => {
        if (err) return reject(err)

        // we don't abort transaction here, and just stops execution
        // browsers implementation also don't abort, and just throw an error
        if (uniqueRecordsCounter) return reject(new Error('Unique index ConstraintError'))
        request(store.keyPath ? store[type](val) : store[type](val, key))
      })
    }

    function request(req) {
      currentIndex += 1

      req.onerror = handleError(reject)
      req.onsuccess = (e) => {
        results.push(e.target.result)
        if (currentIndex < ops.length) next()
      }
    }
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

function countUniqueIndexes(store, key, val, cb) {
  // rely on native support
  if (!isSafari && global.indexedDB !== global.shimIndexedDB) return cb()

  const indexes = slice.call(store.indexNames).map((indexName) => {
    const index = store.index(indexName)
    const indexVal = isCompound(index)
    ? map.call(index.keyPath, (indexKey) => val[indexKey]).filter((v) => Boolean(v))
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
      if (e.target.result && e.target.result !== key) uniqueRecordsCounter += 1
      totalRequestsCounter -= 1
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

function isCompound(index) {
  return typeof index.keyPath !== 'string'
}

/**
 * Create error handler.
 *
 * @param {Function} cb
 * @return {Function}
 */

function handleError(cb) {
  return (e) => {
    // prevent global error throw https://bugzilla.mozilla.org/show_bug.cgi?id=872873
    if (typeof e.preventDefault === 'function') e.preventDefault()
    cb(e.target.error)
  }
}
