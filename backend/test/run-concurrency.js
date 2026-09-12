const { execFileSync, spawnSync } = require('node:child_process');

const output = execFileSync(process.execPath, ['test/prepare-concurrency.js'], { encoding: 'utf8' });
const productLine = output.split(/\r?\n/).find((line) => line.startsWith('PRODUCT_ID='));
const tokensLine = output.split(/\r?\n/).find((line) => line.startsWith('TOKENS='));

if (!productLine || !tokensLine) {
  console.error('Could not read the generated concurrency fixture.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['test/concurrency-test.js'], {
  stdio: 'inherit',
  env: { ...process.env, PRODUCT_ID: productLine.slice('PRODUCT_ID='.length), TOKENS: tokensLine.slice('TOKENS='.length) }
});

process.exitCode = result.status ?? 1;