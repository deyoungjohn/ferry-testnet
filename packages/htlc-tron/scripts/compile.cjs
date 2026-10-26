#!/usr/bin/env node
/* eslint-disable */
const path = require('node:path');
const { execSync } = require('node:child_process');

let tronboxDir;
try {
  tronboxDir = path.dirname(require.resolve('tronbox/package.json'));
} catch {
  const tronboxBin = execSync('which tronbox', { encoding: 'utf8' }).trim();
  tronboxDir = path.resolve(
    path.dirname(tronboxBin),
    '../lib/node_modules/tronbox',
  );
}

const Config = require(path.join(tronboxDir, 'build/components/Config.js'));
const Contracts = require(
  path.join(tronboxDir, 'build/components/WorkflowCompile.js'),
);

const configPath = path.resolve(__dirname, '../tronbox.cjs');
const config = Config.load(configPath, {
  working_directory: path.dirname(configPath),
});

console.log('Compiling Tron contracts via tronbox.cjs...');
Contracts.compile(config.with({ all: false }), (err, result) => {
  if (err) {
    console.error('TronBox compile error:', err);
    process.exit(1);
  }
  const count = result ? Object.keys(result).length : 0;
  console.log(`> Compiled ${count} Tron contracts successfully.`);
});
