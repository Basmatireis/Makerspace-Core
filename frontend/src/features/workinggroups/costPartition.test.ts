import { describe, expect, it } from 'vitest';
import { costPartition } from './projectModel';

describe('costPartition', () => {
  it('adds up to the plan when purchases are only requested', () => {
    const part = costPartition(16000, 0, 16000);
    expect(part).toMatchObject({ spent: 0, requested: 16000, notRequested: 0, over: 0, barTotal: 16000 });
  });

  it('splits spent, requested and not requested yet into the plan', () => {
    const part = costPartition(30000, 5000, 12000);
    expect(part.spent + part.requested + part.notRequested).toBe(30000);
    expect(part).toMatchObject({ spent: 5000, requested: 7000, notRequested: 18000, over: 0 });
  });

  it('shows the surplus as over plan and widens the bar', () => {
    const part = costPartition(10000, 4000, 13000);
    expect(part).toMatchObject({ spent: 4000, requested: 9000, notRequested: 0, over: 3000, barTotal: 13000 });
  });
});
