import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http-client';
import { deletionFailureReasons } from './deletionErrors';

const conflict = (data: object) => new ApiError(409, { message: 'Conflict', requestId: 'req-1', ...data } as never);

describe('deletionFailureReasons', () => {
  it('maps a single known reason', () => {
    const error = conflict({ code: 'person_scim_managed', details: { reasons: [{ code: 'person_scim_managed', message: 'x' }] } });
    expect(deletionFailureReasons(error, 'person')).toEqual(['Provisioned through SCIM. Remove them in the identity provider instead.']);
  });

  it('returns one entry per reason and uses server messages for unknown codes', () => {
    const error = conflict({
      code: 'person_deletion_blocked',
      details: { reasons: [{ code: 'account_scim_managed', message: 'a' }, { code: 'deletion_referenced', message: 'Referenced by orders.' }] },
    });
    expect(deletionFailureReasons(error, 'person')).toEqual([
      'Provisioned through SCIM. Remove the account in the identity provider instead.',
      'Referenced by orders.',
    ]);
  });

  it('falls back to the top-level code and message for legacy responses', () => {
    expect(deletionFailureReasons(conflict({ code: 'last_master_required' }), 'account')[0]).toMatch(/last enabled master/);
    expect(deletionFailureReasons(conflict({ code: 'something_else', message: 'Custom message.' }), 'account')).toEqual(['Custom message.']);
  });

  it('reports unexpected server errors with the request id', () => {
    const error = new ApiError(500, { code: 'internal', message: 'boom', requestId: 'req-9' } as never);
    expect(deletionFailureReasons(error, 'person')).toEqual(['Unexpected server error (request req-9).']);
  });

  it('handles non-API errors and 403/404', () => {
    expect(deletionFailureReasons(new Error('x'), 'person')[0]).toMatch(/could not be reached/);
    expect(deletionFailureReasons(new ApiError(403, { message: 'no' } as never), 'account')).toEqual(['You are not allowed to delete this account.']);
    expect(deletionFailureReasons(new ApiError(404, { message: 'no' } as never), 'account')).toEqual(['Already deleted or no longer visible to you.']);
  });
});
