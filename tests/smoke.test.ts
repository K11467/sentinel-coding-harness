import { expect, test } from 'vitest';
import { harnessName } from '../src/index';

test('测试脚手架可导入最小入口', () => {
  expect(harnessName).toBe('sentinel-coding-harness');
});
