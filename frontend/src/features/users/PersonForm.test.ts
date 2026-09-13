import { describe, expect, it } from 'vitest';
import type { PersonFormValues } from './PersonForm';
import { toPersonCreate, toPersonPatch } from './PersonForm';

const values: PersonFormValues = {
  firstName: ' Ada ',
  lastName: ' Lovelace ',
  email: ' ada@example.test ',
  phone: '',
  matriculationNumber: ' 01234567 ',
};

describe('person request mapping', () => {
  it('never submits a matriculation value without write permission', () => {
    expect(
      toPersonPatch(values, { matriculationNumber: true }, 7, false),
    ).toEqual({ expectedVersion: 7 });
    expect(toPersonCreate(values, false)).not.toHaveProperty('matriculationNumber');
  });

  it('preserves omitted-versus-null patch semantics', () => {
    expect(
      toPersonPatch(values, { firstName: true, phone: true }, 7, true),
    ).toEqual({ expectedVersion: 7, firstName: 'Ada', phone: null });
  });
});
