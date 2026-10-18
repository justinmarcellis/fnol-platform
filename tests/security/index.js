// Lets `node --test tests/security/` work on Node 22, which resolves a directory argument as a module (index.js).
// Plain `node --test tests/security/*.test.mjs` (or the default test discovery) does not run this file.
import('./audit-chain.test.mjs');
import('./pii-leak.test.mjs');
import('./roles.test.mjs');
import('./routes.test.mjs');
import('./tenant-isolation.test.mjs');
