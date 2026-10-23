import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileContract } from './compile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function checkArtifactDrift(): boolean {
  const artifactPath = path.resolve(__dirname, '../src/artifact.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Committed artifact not found at ${artifactPath}`);
  }

  const committed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const fresh = compileContract();

  // Compare structural properties: bytecode, abi, constructorInputs, contractName, source
  const fields = ['contractName', 'bytecode', 'source'] as const;
  for (const field of fields) {
    if (committed[field] !== fresh[field]) {
      throw new Error(`Artifact drift detected in field: ${field}`);
    }
  }

  if (
    JSON.stringify(committed.constructorInputs) !==
    JSON.stringify(fresh.constructorInputs)
  ) {
    throw new Error('Artifact drift detected in constructorInputs');
  }

  if (JSON.stringify(committed.abi) !== JSON.stringify(fresh.abi)) {
    throw new Error('Artifact drift detected in abi');
  }

  return true;
}

if (process.argv[1] === __filename) {
  try {
    checkArtifactDrift();
    console.log(
      'Artifact drift check PASSED: committed artifact matches fresh compile.',
    );
  } catch (err) {
    console.error(
      'Artifact drift check FAILED:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
