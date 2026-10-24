import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import rule from '../eslint-rules/no-secret-logging.mjs';
const lint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      plugins: { ferry: { rules: { 'no-secret-logging': rule } } },
      rules: { 'ferry/no-secret-logging': 'error' },
    },
  ],
});
describe('NFR-6 logging fixture', () => {
  it.each([
    'console.log(secret)',
    'console["warn"]({preimage})',
    'logger.info({secret})',
    'request.logger.debug(order.preimage)',
    'auditLogger.error(`value ${secret}`)',
    'log(preimage)',
    'console.log(sha256(secret))',
    'logger?.warn(preimage)',
  ])('flags %s', async (code) => {
    const [result] = await lint.lintText(code, { filePath: 'fixture.mjs' });
    expect(
      result.messages.some(
        (message) => message.ruleId === 'ferry/no-secret-logging',
      ),
    ).toBe(true);
  });
  it.each([
    'console.log(hashLock)',
    'logger.info({orderId})',
    'claim(secret)',
    'const preimage = value',
    'console.info("public status")',
  ])('allows %s', async (code) => {
    const [result] = await lint.lintText(code, { filePath: 'fixture.mjs' });
    expect(result.errorCount).toBe(0);
  });
});
