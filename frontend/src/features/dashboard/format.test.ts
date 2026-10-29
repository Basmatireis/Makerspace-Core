import { describe, expect, it } from 'vitest';
import { pickGreeting } from './format';

const noon = Date.parse('2026-10-29T10:00:00Z');
const base = { now: noon, firstName: 'Ada', funGreetings: ['Hello {name}!', 'Hammer time'], funGreetingShare: 30 };

/** A `random` that returns the given numbers in turn. */
const sequence = (...values: number[]) => {
  let next = 0;
  return () => values[next++];
};

describe('pickGreeting', () => {
  it('uses a playful greeting when the roll is below the share and puts the first name where {name} is', () => {
    expect(pickGreeting({ ...base, random: sequence(0.29, 0) })).toBe('Hello Ada!');
  });

  it('shows a greeting without {name} on its own', () => {
    expect(pickGreeting({ ...base, random: sequence(0.1, 0.99) })).toBe('Hammer time');
  });

  it('falls back to the time-of-day greeting with the name when the roll is at or above the share', () => {
    expect(pickGreeting({ ...base, random: sequence(0.3, 0) })).toMatch(/^Good (morning|afternoon|evening), Ada$/);
  });

  it('never shows playful greetings with a share of 0 or an empty list', () => {
    expect(pickGreeting({ ...base, funGreetingShare: 0, random: () => 0 })).toMatch(/, Ada$/);
    expect(pickGreeting({ ...base, funGreetings: [], funGreetingShare: 100, random: () => 0 })).toMatch(/, Ada$/);
  });

  it('always shows one with a share of 100', () => {
    expect(pickGreeting({ ...base, funGreetingShare: 100, random: sequence(0.999, 0.5) })).toBe('Hammer time');
  });
});
