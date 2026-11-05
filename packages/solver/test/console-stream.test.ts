import { describe, expect, it } from 'vitest';
import {
  createConsoleStream,
  formatConsoleLine,
} from '../src/ops/console-stream.js';

describe('console log formatting', () => {
  it('turns a huge error record into one short line', () => {
    const huge = 'x'.repeat(20_000);
    const line = formatConsoleLine(
      JSON.stringify({
        level: 50,
        time: 1793377346896,
        msg: 'Error processing order',
        orderId: `0x${'ab'.repeat(32)}`,
        err: {
          shortMessage: 'The contract function "lock" reverted.',
          message: `${huge}\nVersion: viem`,
          stack: huge,
        },
      }),
    );
    expect(line).toContain('ERROR Error processing order');
    expect(line).toContain('order=0xabababab');
    expect(line).toContain('The contract function "lock" reverted.');
    expect(line.length).toBeLessThan(300);
    expect(line.includes('\n')).toBe(false);
  });

  it('truncates a long first line and handles non-JSON input', () => {
    const line = formatConsoleLine(
      JSON.stringify({
        level: 40,
        msg: 'm',
        err: { message: 'y'.repeat(900) },
      }),
    );
    expect(line.length).toBeLessThan(320);
    expect(formatConsoleLine('plain text')).toBe('plain text');
  });

  it('reassembles records split across chunks', () => {
    const out: string[] = [];
    const stream = createConsoleStream((l) => out.push(l));
    const record = JSON.stringify({ level: 40, time: 0, msg: 'hello' });
    stream.write(record.slice(0, 10));
    stream.write(`${record.slice(10)}\n`);
    expect(out).toEqual(['00:00:00 WARN  hello']);
  });
});
