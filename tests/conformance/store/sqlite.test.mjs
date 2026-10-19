import { runStoreConformance } from './suite.mjs';
import { createStore } from '../../../src/core/store.mjs';
import { wrapSyncStore } from '../../../src/core/store-port.mjs';

runStoreConformance('sqlite (in-memory, wrapSyncStore)', async () => wrapSyncStore(createStore(':memory:')));
