import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noSecretLogging from './eslint-rules/no-secret-logging.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/target/**',
      '**/out/**',
      '**/cache/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { ferry: { rules: { 'no-secret-logging': noSecretLogging } } },
    rules: { 'ferry/no-secret-logging': 'error' },
  },
);
