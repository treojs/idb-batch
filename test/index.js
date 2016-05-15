// setup PhantomJS, Webkit, IE env
import 'polyfill-function-prototype-bind'
import 'indexeddbshim'
import ES6Promise from 'es6-promise'
import 'regenerator-runtime-only/runtime'

ES6Promise.polyfill()
if (navigator.userAgent.indexOf('Trident') !== -1) {
  console.log('force IE to enable compound indexes using indexeddbshim') // eslint-disable-line
  window.shimIndexedDB.__useShim()
}

import { expect } from 'chai'
import { del, open } from 'idb-factory'
import { request } from 'idb-request'
import Schema from 'idb-schema'
import batch, { transactionalBatch, getStoreNames } from '../src'

describe('idb-batch', () => {
  let db
  const dbName = 'idb-batch'
  const schema = new Schema()
  .addStore('books')
  .addIndex('byTitle', 'title', { unique: true }) // simple index
  .addIndex('byAuthor', 'author')
  .addStore('magazines', { key: 'id', increment: true })
  .addIndex('byName', 'name')
  .addIndex('byNameAndFrequency', ['name', 'frequency'], { unique: true }) // compound index
  .addStore('storage')
  .addIndex('byFoo', 'foo')

  beforeEach(async () => {
    db = await open(dbName, schema.version(), schema.callback())
  })

  before(() => del(db || dbName))
  afterEach(() => del(db || dbName))

  it('supports object syntax', async () => {
    const res1 = await batch(db, 'books', {
      key1: { title: 'B1', author: 'Bob' },
      key2: { title: 'B2', author: 'Bob' },
      3: { title: 'B3', author: 'Karl' },
    })

    expect(res1.sort()).eql(['key1', 'key2', '3'].sort()) // object keys don't guarantee order
    expect(await count(db, 'books')).equal(3)
    expect(await get(db, 'books', 'key1')).eql({ title: 'B1', author: 'Bob' })
    expect(await get(db, 'books', '3')).eql({ title: 'B3', author: 'Karl' })
    expect(await get(db, 'books', 3)).eql(undefined)

    const res2 = await batch(db, 'books', {
      key1: null,
      key2: null,
      3: { title: 'B3', author: 'Bob' },
    })

    expect(res2.sort()).eql([undefined, undefined, '3'].sort())
    expect(await count(db, 'books')).equal(1)
    expect(await get(db, 'books', '3')).eql({ title: 'B3', author: 'Bob' })
  })

  it('supports array syntax', async () => {
    const res1 = await batch(db, 'magazines', [
      { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
      { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
      { type: 'add', value: { id: 3, name: 'M3', frequency: 6 } },
      { type: 'add', value: { id: 4, name: 'M4', frequency: 52 } },
    ])

    expect(res1).eql([1, 2, 3, 4])
    expect(await count(db, 'magazines')).equal(4)
    expect(await get(db, 'magazines', 2)).eql({ id: 2, name: 'M2', frequency: 24 })
    expect(await get(db, 'magazines', 4)).eql({ id: 4, name: 'M4', frequency: 52 })

    const res2 = await batch(db, 'magazines', [
      { type: 'del', key: 1 },
      { type: 'put', key: 2, value: { name: 'M2', frequency: 24, foo: 'bar' } },
      { type: 'del', key: 3 },
    ])

    expect(res2).eql([undefined, 2, undefined])
    expect(await count(db, 'magazines')).equal(2)
    expect(await get(db, 'magazines', 2)).eql({ id: 2, name: 'M2', frequency: 24, foo: 'bar' })

    const res3 = await batch(db, 'magazines', [{ type: 'clear' }])
    expect(res3).eql([undefined])
    expect(await count(db, 'magazines')).equal(0)
  })

  it('works with any type of data (not only objects)', async () => {
    await batch(db, 'storage', {
      key1: 'value',
      key2: 123456,
      key3: [1, 2, 3],
      key4: { foo: 'bar' },
    })

    expect(await count(db, 'storage')).equal(4)
    expect(await get(db, 'storage', 'key1')).equal('value')
    expect(await get(db, 'storage', 'key2')).equal(123456)
    expect(await get(db, 'storage', 'key3')).eql([1, 2, 3])
    expect(await get(db, 'storage', 'key4')).eql({ foo: 'bar' })
  })

  it('validates unique indexes', async () => {
    const errors = []

    try {
      await batch(db, 'books', {
        1: { title: 'book', author: 'Petr' },
        2: { title: 'book', author: 'John' }, // error byTitle index
        3: { title: 'my book', author: 'John' },
      })
    } catch (err) {
      errors.push('simple index')
    }

    try {
      await batch(db, 'magazines', [
        { type: 'add', value: { name: 'magazine', frequency: 1 } },
        { type: 'add', value: { name: 'magazine', frequency: 1 } }, // error byNameAndFrequency index
        { type: 'add', value: { name: 'magazine', frequency: 2 } },
      ])
    } catch (err) {
      errors.push('compound index')
    }

    expect(errors).eql(['simple index', 'compound index'])
    expect(await count(db, 'books')).equal(1) // because transaction wasn't aborted
    expect(await count(db, 'magazines')).equal(1)
  })

  it('validates arguments', async (done) => {
    const errors = []
    const funcs = [
      async () => await batch(db, 'books'),
      async () => await batch(db, 123, { a: 1 }),
      async () => await batch(db, 'books', JSON.stringify({ a: 1 })),
      async () => await batch(db, 'magazines', [{ type: 'delete', key: 'foo' }]),
      async () => await batch(db, 'magazines', [['put', '1']]),
    ]
    funcs.forEach(async (func, i) => {
      try {
        await func()
      } catch (err) {
        errors.push(err)
      }
      if (i === funcs.length - 1) {
        expect(errors).eql([
          'invalid arguments length',
          'invalid "storeName"',
          'invalid "ops"',
          'invalid type "delete"',
          'invalid op',
        ].map((msg) => new TypeError(msg)))
        done()
      }
    })
  })

  describe('transactionalBatch', () => {
    this.timeout(5000)

    it('supports batch in series', async () => {
      let gotCbResults = false
      let gotCb2Results = false
      let prom
      const res = await transactionalBatch(db, [
        {
          magazines: [
            { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
            { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
            { type: 'add', key: 3, value: { name: 'M3', frequency: 6 } },
            { type: 'del', key: 2 },
          ],
        },
        function callbackInTransaction(tr) {
          prom = new Promise((resolve) => {
            const magazines = tr.objectStore('magazines')
            const req = magazines.add({ name: 'M4', frequency: 8, [magazines.keyPath]: 5 })
            req.onsuccess = (e) => {
              expect(e.target.result).equal(5)
              // We can't do a timeout here as with the parallel test as we need the transaction to be the same
              const req2 = magazines.put({ name: 'M1', frequency: 17, [magazines.keyPath]: 1 })
              req2.onsuccess = (e2) => {
                expect(e2.target.result).equal(1)
                gotCbResults = true
                expect(gotCb2Results).equal(false)
                resolve('finished')
              }
            }
          })
          return prom
        },
        function callback2InTransaction(tr) {
          const magazines = tr.objectStore('magazines')
          const req = magazines.get(1)
          req.onsuccess = (e) => {
            gotCb2Results = true
            expect(e.target.result).eql({ name: 'M1', frequency: 17, id: 1 })
          }
        },
        {
          books: [
            { type: 'put', key: 1, value: { name: 'M1', frequency: 12 } },
            { type: 'move', key: 2, value: 1 },
            { type: 'copy', key: 3, value: 2 },
          ],
          storage: 'clear',
        },
      ])

      expect(res).eql([{ magazines: [1, 2, 3, undefined] }, prom, undefined, { books: [1, 2, undefined, 3], storage: [undefined] }])
      expect(await count(db, 'magazines')).equal(3)
      expect(await count(db, 'books')).equal(2)
      expect(await count(db, 'storage')).equal(0)
      expect(gotCbResults).equal(true)
    })

    it('supports batch in parallel', async (done) => {
      let gotCbResults = false
      let gotCb2Results = false
      const res = await transactionalBatch(db, [
        {
          magazines: [
            { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
            { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
            { type: 'add', key: 3, value: { name: 'M3', frequency: 6 } },
            { type: 'del', key: 2 },
          ],
        },
        function callbackInTransaction(tr) {
          return new Promise((resolve) => {
            const magazines = tr.objectStore('magazines')
            const req = magazines.add({ name: 'M4', frequency: 8, [magazines.keyPath]: 5 })
            req.onsuccess = (e) => {
              expect(e.target.result).equal(5)
              setTimeout(() => { // To test parallel we need a timeout, but this requires our needing to
                // create the transaction anew (though after a long enough time to ensure the original transaction is not still open)
                const trans = db.transaction('magazines', 'readwrite')
                const mags = trans.objectStore('magazines')
                const req2 = mags.put({ name: 'M1', frequency: 17, [mags.keyPath]: 1 })
                req2.onsuccess = (e2) => {
                  expect(e2.target.result).equal(1)
                  gotCbResults = true
                  expect(gotCb2Results).equal(true)
                  resolve('finished')
                }
              }, 500)
            }
          })
        },
        function callback2InTransaction(tr) {
          const magazines = tr.objectStore('magazines')
          const req = magazines.get(1)
          req.onsuccess = (e) => {
            gotCb2Results = true
            expect(gotCbResults).equal(false)
            expect(e.target.result).eql({ name: 'M1', frequency: 12, id: 1 })
          }
        },
        {
          books: [
            { type: 'put', key: 1, value: { name: 'M1', frequency: 12 } },
            { type: 'move', key: 2, value: 1 },
            { type: 'copy', key: 3, value: 2 },
          ],
          storage: 'clear',
        },
      ], { parallel: true })
      expect(res).eql([{ magazines: [1, 2, 3, undefined] }, new Promise(() => {}), undefined, { books: [1, 2, undefined, 3], storage: [undefined] }])
      expect(await count(db, 'magazines')).equal(3)
      expect(await count(db, 'books')).equal(2)
      expect(await count(db, 'storage')).equal(0)
      res[1].then((result) => {
        expect(result).equal('finished')
        done()
      })
    })

    it('supports resolving early (and continuing transaction)', async (done) => {
      const ops = [
        {
          magazines: [
            { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
            { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
            { type: 'add', key: 3, value: { name: 'M3', frequency: 6 } },
            { type: 'del', key: 2 },
          ],
        },
      ]
      const trans = db.transaction(getStoreNames(ops), 'readwrite')
      const res = await transactionalBatch(trans, ops, { resolveEarly: true })
      expect(res).eql([{ magazines: [1, 2, 3, undefined] }])
      const magazines = trans.objectStore('magazines')
      const req = magazines.add({ name: 'M4', frequency: 8, [magazines.keyPath]: 5 })
      req.onsuccess = (e) => {
        expect(e.target.result).equal(5)
        done()
      }
    })

    it('supports aborting a batch transaction', async () => {
      try {
        await transactionalBatch(db, [
          {
            magazines: [
              { type: 'add', key: 1, value: { name: 'M1', frequency: 12 } },
              { type: 'add', key: 2, value: { name: 'M2', frequency: 24 } },
              { type: 'add', key: 3, value: { name: 'M3', frequency: 6 } },
              { type: 'del', key: 2 },
            ],
          },
          function callbackInTransaction(tr) {
            tr.abort()
          },
        ])
      } catch (err) {
        expect(await count(db, 'magazines')).equal(0)
      }
    })
  })
})

/**
 * IDB store helpers.
 */

function count(db, storeName) {
  return request(db.transaction(storeName).objectStore(storeName).count())
}

function get(db, storeName, key) {
  return request(db.transaction(storeName).objectStore(storeName).get(key))
}
