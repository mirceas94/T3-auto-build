// Tier-1 availability: zero-inference discovery, the cached availability file and model drift. The work lives in ./discover/.
export { discover, parseFamily } from './discover/sources.mjs';
export { markAvailability, parseTtl, readAvailabilityFile, writeAvailability } from './discover/cache.mjs';
export { applyDrift, checkModels } from './discover/merge.mjs';
