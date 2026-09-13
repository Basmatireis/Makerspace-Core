import { Button, Form, InlineNotification, Stack, Tile } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createPerson } from '../../api/generated/people/people';
import { PageHeader } from '../../app/PageHeader';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import {
  PersonFields,
  type PersonFormValues,
  toPersonCreate,
} from './PersonForm';
import { peopleKeys } from './queries';

const EMPTY_PERSON: PersonFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  matriculationNumber: '',
};

export function UserCreatePage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<PersonFormValues>({ defaultValues: EMPTY_PERSON });
  const canWriteMatriculation = hasPermission(
    currentUser,
    PermissionId.peopleupdatematriculation,
  );
  const createMutation = useMutation({
    mutationFn: (request: Parameters<typeof createPerson>[0]) =>
      createPerson(request),
    onSuccess: async (person) => {
      await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
      navigate(`/settings/users/${person.id}`, { replace: true });
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync(
        toPersonCreate(values, canWriteMatriculation),
      );
    } catch {
      // The mutation state renders the actionable error without leaking server details.
    }
  });

  return (
    <Stack gap={7}>
      <PageHeader
        title="Add person"
        breadcrumbs={[
          { label: 'Settings', to: '/settings' },
          { label: 'Users', to: '/settings/users' },
        ]}
        description="Create a person record. A login account can be added afterward."
      />
      <Tile className="form-tile">
        <Form onSubmit={onSubmit}>
          <Stack gap={7}>
            {createMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Person not created"
                subtitle="Review the information and try again."
              />
            )}
            <PersonFields
              form={form}
              showMatriculation={canWriteMatriculation}
              editMatriculation={canWriteMatriculation}
            />
            <div className="form-actions">
              <Button kind="secondary" type="button" onClick={() => navigate('/settings/users')}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating…' : 'Create person'}
              </Button>
            </div>
          </Stack>
        </Form>
      </Tile>
    </Stack>
  );
}
