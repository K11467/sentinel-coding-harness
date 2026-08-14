import { expect, test } from 'vitest';

test('Vitest 能报告失败的断言', () => {
  expect(true).toBe(false);
});
