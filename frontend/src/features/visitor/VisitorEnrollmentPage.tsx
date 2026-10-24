import { Stack } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import {
  beginVisitorEnrollment,
  getVisitorEnrollmentState,
} from '../../api/generated/visitor-enrollment/visitor-enrollment';
import { PageHeader } from '../../app/PageHeader';
import { InlineLoadingState } from '../../app/PageState';
import { LegalLinks } from '../branding/LegalLinks';
import { VisitorWizard } from './VisitorWizard';

export function VisitorEnrollmentPage() {
  const begin = useQuery({
    queryKey: ['visitor-enrollment', 'begin'],
    queryFn: async () => {
      await beginVisitorEnrollment();
      // TanStack Query requires successful query functions to return a defined
      // value. The API deliberately responds with 204 after setting cookies.
      return true;
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const state = useQuery({
    queryKey: ['visitor-enrollment', 'state'],
    queryFn: ({ signal }) => getVisitorEnrollmentState({ signal }),
    enabled: begin.isSuccess,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  if (begin.isPending || (begin.isSuccess && state.isPending))
    return (
      <main className="public-page">
        <Stack gap={6}>
          <InlineLoadingState label="Verifying this visitor terminal" />
          <LegalLinks />
        </Stack>
      </main>
    );
  if (begin.isError || state.isError || !state.data)
    return (
      <main className="public-page">
        <Stack gap={6}>
          <PageHeader
            title="Visitor enrollment unavailable"
            description="This browser is not an enabled visitor terminal. Ask a staff member to verify its ManagedDevice configuration."
          />
          <LegalLinks />
        </Stack>
      </main>
    );
  return <VisitorWizard state={state.data} />;
}
