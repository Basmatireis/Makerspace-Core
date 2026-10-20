import { useState } from 'react';
import { Button, Link as CarbonLink, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createStreamingGateway, createStreamingGatewayEnrollment } from '../../api/generated/local-services/local-services';
import type { StreamingGateway, StreamingGatewayEnrollmentIssue } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { EnrollmentSecretModal, GatewayFormModal, GatewayStatusTag } from './components';
import { dateOrDash, errorText } from './helpers';
import { camerasQuery, gatewaysQuery, localServiceKeys } from './queries';

export function LocalServicesPage() {
  const queryClient = useQueryClient();
  const gateways = useQuery(gatewaysQuery());
  const cameras = useQuery(camerasQuery());
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ gateway: StreamingGateway; issue: StreamingGatewayEnrollmentIssue } | null>(null);
  const now = Date.now();

  const add = useMutation({
    mutationFn: async (values: { name: string; publicHost: string }) => {
      const gateway = await createStreamingGateway(values);
      // A gateway can only be used once it is enrolled, so the secret is issued right away.
      return { gateway, issue: await createStreamingGatewayEnrollment(gateway.id) };
    },
    onSuccess: async (result) => {
      setAdding(false);
      setSecret(result);
      await queryClient.invalidateQueries({ queryKey: localServiceKeys.all });
    },
  });

  const items = gateways.data?.items ?? [];
  const countOf = (id: string) => (cameras.data?.items ?? []).filter((camera) => camera.gatewayId === id).length;
  const addButton = <Button renderIcon={Add} onClick={() => { add.reset(); setAdding(true); }}>Add gateway</Button>;

  return (
    <PageShell title="Local services" description="Software that runs in the makerspace network next to Core." width="wide" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} actions={addButton}>
      <section aria-labelledby="gateways-title">
        <h2 id="gateways-title" className="cds--type-heading-03">Streaming gateways</h2>
        <p>Restream printer cameras to the digital signage displays. Video never passes through Core.</p>
        {gateways.isPending && <InlineLoadingState label="Loading streaming gateways" />}
        {gateways.isError && <ErrorState message={errorText(gateways.error, 'The streaming gateways could not be loaded.')} onRetry={() => void gateways.refetch()} />}
        {gateways.isSuccess && (items.length === 0 ? (
          <EmptyState title="No streaming gateways yet" description="Add a gateway, then start it on a computer in the makerspace network with the enrollment secret." action={addButton} />
        ) : (
          <TableContainer>
            <Table aria-label="Streaming gateways">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader><TableHeader>Status</TableHeader><TableHeader>Version</TableHeader><TableHeader>Public host</TableHeader><TableHeader>Cameras</TableHeader><TableHeader>Enrolled</TableHeader><TableHeader>Credential expires</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((gateway) => (
                  <TableRow key={gateway.id}>
                    <TableCell><CarbonLink as={Link} to={`/settings/local-services/${gateway.id}`}>{gateway.name}</CarbonLink></TableCell>
                    <TableCell><GatewayStatusTag gateway={gateway} now={now} /></TableCell>
                    <TableCell>{gateway.softwareVersion ?? '—'}</TableCell>
                    <TableCell>{gateway.publicHost}</TableCell>
                    <TableCell>{cameras.isSuccess ? countOf(gateway.id) : '…'}</TableCell>
                    <TableCell>{dateOrDash(gateway.enrolledAt)}</TableCell>
                    <TableCell>{dateOrDash(gateway.credentialExpiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ))}
      </section>
      <section aria-labelledby="connectors-title">
        <h2 id="connectors-title" className="cds--type-heading-03">Printer connectors</h2>
        <p>Printer connectors are managed under Machines. <CarbonLink as={Link} to="/machine-logbook/machines?tab=connectors">Open Machines, Connectors</CarbonLink></p>
      </section>
      {adding && <GatewayFormModal pending={add.isPending} error={add.isError ? errorText(add.error) : undefined} onSubmit={(values) => add.mutate(values)} onClose={() => setAdding(false)} />}
      {secret && <EnrollmentSecretModal gateway={secret.gateway} issue={secret.issue} onClose={() => setSecret(null)} />}
    </PageShell>
  );
}
