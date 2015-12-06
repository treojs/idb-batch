// setup PhantomJS, Webkit, IE env
import 'polyfill-function-prototype-bind'
import 'indexeddbshim'
import 'regenerator/runtime'
import ES6Promise from 'es6-promise'

ES6Promise.polyfill()
if (navigator.userAgent.indexOf('Trident') !== -1) {
  console.log('force IE to enable compound indexes using indexeddbshim') // eslint-disable-line
  window.shimIndexedDB.__useShim()
}

import { expect } from 'chai'
import { del, open } from 'idb-factory'
import { request } from 'idb-request'
import Schema from 'idb-schema'
import batch from '../src'

describe('idb-schema', () => {
  let db
  const dbName = 'idb-schema'
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

    expect(res1.sort()).eql(['key1', 'key2', '3'].sort()) // object keys don't gurante order
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

  it('validates arguments', () => {
    expect(() => batch(db, 'books')).throws('invalid arguments length')
    expect(() => batch(db, 123, { a: 1 })).throws('invalid "storeName"')
    expect(() => batch(db, 'books', JSON.stringify({ a: 1 }))).throws('invalid "ops"')

    expect(() => batch(db, 'magazines', [{ type: 'delete', key: 'foo' }])).throws('invalid type "delete"')
    expect(() => batch(db, 'magazines', [['put', '1']])).throws('invalid op')
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
