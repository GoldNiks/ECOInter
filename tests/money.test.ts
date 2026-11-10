import test from 'node:test';
import assert from 'node:assert/strict';
import { add, div, money, moneyString, mul, mulInt, portion, ratioPercent, sub } from '../server/domain/money.ts';

test('fixed-point money preserves decimal arithmetic', () => {
  assert.equal(moneyString(add(money('0.1'), money('0.2'))), '0.3');
  assert.equal(moneyString(sub(money('10.55'), money('0.55'))), '10');
  assert.equal(moneyString(mul(money('12.5'), money('0.08'))), '1');
  assert.equal(moneyString(div(money('1'), money('4'))), '0.25');
  assert.equal(moneyString(mulInt(money('3.25'), 4)), '13');
});

test('portion keeps the full lot total exact', () => {
  assert.equal(moneyString(portion(money('200'), 3, 3)), '200');
  assert.equal(moneyString(portion(money('200'), 1, 3)), '66.66666666');
});

test('ROI uses percentage points', () => {
  assert.equal(moneyString(ratioPercent(money('350'), money('150'))), '233.33333333');
});

test('invalid money values are rejected', () => {
  assert.throws(() => money('1,25'));
  assert.throws(() => money('-1.000000001'));
});
