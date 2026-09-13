import { afterEach, describe, expect, it } from 'vitest';
import { clearPrivateQueryData, queryClient } from './query-client';

describe('private query cleanup', () => {
  afterEach(() => queryClient.clear());

  it('clears cached account and person data on logout or expiry', () => {
    queryClient.setQueryData(['auth', 'current-user'], { secret: 'private' });
    queryClient.setQueryData(['people', 'detail', 'person-id'], { email: 'private@example.test' });

    clearPrivateQueryData();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
