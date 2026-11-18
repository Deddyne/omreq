import { spawnSync } from 'node:child_process';

const result = spawnSync('bun', ['test', 'tests/'], { stdio: 'inherit', timeout: 120000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
