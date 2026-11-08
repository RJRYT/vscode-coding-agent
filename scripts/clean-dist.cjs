const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'dist');
fs.rmSync(target, { recursive: true, force: true });
process.stdout.write(`Cleaned build output: ${target}\n`);
