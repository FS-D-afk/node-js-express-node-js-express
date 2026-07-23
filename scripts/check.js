const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'data',
  'public',
]);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const files = collectJavaScriptFiles(projectRoot);
for (const file of files) {
  run(process.execPath, ['--check', file]);
}
console.log(`Syntax check passed (${files.length} JavaScript files).`);

run(process.execPath, [path.join('scripts', 'smoke-test.js')]);
