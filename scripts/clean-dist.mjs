import { rmSync } from 'node:fs';

// build:js output only; removing it first keeps renamed or deleted modules out of the tarball.
rmSync('packages/omreq/dist', { recursive: true, force: true });
