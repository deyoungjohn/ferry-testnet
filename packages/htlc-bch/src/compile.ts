import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile } from 'cashc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function compileContract() {
  const contractPath = path.resolve(__dirname, '../contracts/FerryHTLC.cash');
  const artifact = compileFile(contractPath);
  return artifact;
}

export function writeArtifact() {
  const artifact = compileContract();
  const artifactPath = path.resolve(__dirname, '../src/artifact.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(artifact, null, 2) + '\n',
    'utf8',
  );
  console.log(`Compiled FerryHTLC.cash successfully -> ${artifactPath}`);
  return artifact;
}

if (process.argv[1] === __filename) {
  writeArtifact();
}
