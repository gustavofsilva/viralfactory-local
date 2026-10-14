import test from 'node:test';
import assert from 'node:assert/strict';
import { afterBurstPublication } from '../src/episode-burst.js';

test('three confirmed publications restore the hourly interval', () => {
  const now = new Date('2026-10-14T03:00:00.000Z');
  const first = afterBurstPublication({ burstTarget: 3, burstSuccesses: 0, intervalMinutes: 60 }, now)!;
  const second = afterBurstPublication({ ...first, intervalMinutes: 60 }, now)!;
  const third = afterBurstPublication({ ...second, intervalMinutes: 60 }, now)!;
  assert.deepEqual([first.burstSuccesses, second.burstSuccesses, third.burstSuccesses], [1, 2, 3]);
  assert.equal(first.burstTarget, 3);
  assert.equal(second.burstTarget, 3);
  assert.equal(third.burstTarget, 0);
  assert.equal(first.nextPublishAt.toISOString(), now.toISOString());
  assert.equal(third.nextPublishAt.toISOString(), '2026-10-14T04:00:00.000Z');
  assert.equal(afterBurstPublication({ burstTarget: 0, burstSuccesses: 3, intervalMinutes: 60 }, now), null);
});
