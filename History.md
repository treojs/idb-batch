# idb-batch

## ?

* Breaking change: for object syntax, modify merge patch behavior to use '\0'
  for deletions and requiring strings with initial '\0' to include one extra;
  add tests
* Breaking change (minor): Switch to promise rejections instead of immediately synchronous errors for `batch()`/`transactionalBatch()`
* Breaking change (minor): Allow succincter `{add: {}}` and `{add: [{}]}` style operations
* Feature: Support `transactionalBatch`
* Feature: Added `getStoreNames`
* Feature: Allow preexisting transaction to be supplied to `batch()` (or `transactionalBatch()`)
* Feature: Support `move`, `copy` operations

## 1.0.0 / 2015-12-06

* initial release :sparkles:
