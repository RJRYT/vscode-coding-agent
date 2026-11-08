const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '..', 'resources');
const destination = path.resolve(__dirname, '..', 'dist', 'src', 'resources');

if (!fs.existsSync(source)) {
  throw new Error(`Required extension resources directory is missing: ${source}`);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true, force: true });
process.stdout.write(`Copied extension resources to ${destination}\n`);
