import { describe, expect, it } from 'vitest';
import { nextVersion, statusOf } from './status';

describe('statusOf', () => {
  it('says built-in default when nothing was saved', () => {
    expect(statusOf({ dirty: false, draft: null, published: null })).toEqual({
      label: 'Built-in default',
      tone: 'gray',
    });
  });
  it('shows the published version', () => {
    expect(statusOf({ dirty: false, draft: null, published: { version: 4 } })).toEqual({
      label: 'Published v4',
      tone: 'green',
    });
  });
  it('shows a saved draft over the published version', () => {
    expect(statusOf({ dirty: false, draft: { version: 5 }, published: { version: 4 } }).label).toBe('Draft v5');
  });
  it('shows unsaved edits with the version the draft has or will get', () => {
    expect(statusOf({ dirty: true, draft: { version: 5 }, published: { version: 4 } }).label).toBe(
      'Draft v5 · unsaved',
    );
    expect(statusOf({ dirty: true, draft: null, published: { version: 4 } }).label).toBe('Draft v5 · unsaved');
    expect(statusOf({ dirty: true, draft: null, published: null }).label).toBe('Draft v1 · unsaved');
    expect(nextVersion(null, { version: 2 })).toBe(3);
  });
});
