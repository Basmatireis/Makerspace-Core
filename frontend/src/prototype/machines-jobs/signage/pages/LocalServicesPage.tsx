import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, Tile } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { DestructiveActionDialog } from '../../../../app/DestructiveActionDialog';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useStore } from '../../store';
import { EnrollServiceModal } from '../dialogs/EnrollServiceModal';
import { cameraState } from '../helpers';
import { camerasSeed } from '../mockData';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import type { LocalService } from '../types';
import '../signage.scss';

const STATE_TAG = { online: { type: 'green', label: 'Online' }, offline: { type: 'red', label: 'Offline' }, revoked: { type: 'gray', label: 'Revoked' } } as const;

export function LocalServicesPage() {
  const store = useStore();
  const signage = useSignage();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<LocalService | null>(null);
  const query = useSignageQuery(signage.services, []);
  const services = query.data;
  const add = <Button renderIcon={Add} onClick={() => setAdding(true)}>Add service</Button>;

  return (
    <RequirePermission permission="local_services.manage" title="Local services" crumbs={[{ label: 'Settings' }]}>
      <PageShell title="Local services" description="Small programs that run in the makerspace network and connect printers and cameras to Core." width="wide" breadcrumbs={[{ label: 'Settings' }]} actions={add}>
        <QueryBoundary query={query} errorMessage="The local services could not be loaded.">
          <div className="mj-stack">
            <Tile className="sg-installation">
              <h2 className="mj-section-title">Makerspace Graz</h2>
              <p className="mj-secondary">One installation per location. Services connect out to Core; nothing in your network has to be reachable from the internet.</p>
              <div className="sg-installation__table">
                {services.length === 0 ? <EmptyState title="No local services yet" description="Add a printer connector or a streaming gateway." action={add} /> : (
                  <TableContainer className="mj-table-container">
                    <Table aria-label="Local services">
                      <TableHead><TableRow><TableHeader>Service</TableHeader><TableHeader>Status</TableHeader><TableHeader className="mj-hide-narrow">Version</TableHeader><TableHeader>Details</TableHeader><TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader></TableRow></TableHead>
                      <TableBody>
                        {services.map((service) => (
                          <TableRow key={service.id}>
                            <TableCell>{service.name}</TableCell>
                            <TableCell><Tag type={STATE_TAG[service.state].type} size="md">{STATE_TAG[service.state].label}</Tag></TableCell>
                            <TableCell className="mj-hide-narrow">{service.version === '—' ? '—' : `v${service.version}`}</TableCell>
                            <TableCell><div className="mj-cell-stack"><span>{service.detail}</span>{service.state !== 'revoked' && <span className="mj-secondary">Credential rotates in {service.rotatesInDays} days</span>}</div></TableCell>
                            <TableCell className="sales-row-actions">
                              {service.state !== 'revoked' && (
                                <OverflowMenu flipped size="sm" aria-label={`Actions for ${service.name}`}>
                                  <OverflowMenuItem itemText="Rotate credential" onClick={() => signage.rotateService(service.id)} />
                                  <OverflowMenuItem itemText="Revoke" isDelete hasDivider onClick={() => setRevoking(service)} />
                                </OverflowMenu>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </div>
            </Tile>
            <Tile>
              <h2 className="mj-section-title">Cameras</h2>
              <TableContainer className="mj-table-container">
                <Table aria-label="Cameras">
                  <TableHead><TableRow><TableHeader>Machine</TableHeader><TableHeader className="mj-hide-narrow">Gateway</TableHeader><TableHeader>Status</TableHeader><TableHeader>Viewers</TableHeader><TableHeader className="mj-hide-narrow">Stream format</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {camerasSeed.map((camera) => {
                      const sim = signage.sim[camera.machine];
                      const base = cameraState(sim, signage.sim.coreReachable);
                      const state = base.label === 'Idle' ? { ...base, label: 'Idle — no viewer' } : base;
                      return (
                        <TableRow key={camera.machine}>
                          <TableCell>{camera.name}</TableCell><TableCell className="mj-hide-narrow">{camera.gateway}</TableCell>
                          <TableCell><Tag type={state.type} size="md">{state.label}</Tag></TableCell>
                          <TableCell>{base.label === 'Live' ? 1 : 0}</TableCell><TableCell className="mj-hide-narrow">{camera.format}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              <p className="mj-secondary sg-top-gap">Camera access codes are configured on the machine’s connection and are never shown here.</p>
            </Tile>
          </div>
        </QueryBoundary>
        {adding && <EnrollServiceModal onClose={() => setAdding(false)} />}
        <DestructiveActionDialog open={revoking !== null} title="Revoke service" confirmLabel="Revoke" onClose={() => setRevoking(null)} onConfirm={() => { if (revoking) signage.revokeService(revoking.id); setRevoking(null); store.notify({ kind: 'success', title: 'Service revoked' }); }}>
          <p>{revoking?.name} loses access to Core immediately. Printers and cameras it handled go offline until you enroll a new service.</p>
        </DestructiveActionDialog>
      </PageShell>
    </RequirePermission>
  );
}
