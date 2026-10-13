import { useState } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';
import { PermissionId } from '../../../api/generated/models';
import type { MachineJob, Print } from '../../../api/generated/models';
import { server } from '../../../test/server';
import { renderRoute } from '../../../test/render';
import { DirectoryTable, useServerTableState, type Column } from './DirectoryTable';
import { machineLogbookPaths } from './paths';
import { QueryBoundary } from './QueryBoundary';
import { adjustmentSummary, billingStateOptions, connectorIssue, displayName, jobRowStatusOptions, nameFromFile, replaceChangesAnything, workItemName, workItemSecondaryIds } from './status';
import { formatDuration, formatMoney } from './format';
import { ToastProvider } from './toasts';
import { useCan } from './useCan';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));
import { useLinkPrint } from './useLinkPrint';

describe('Machines & Jobs shared helpers', () => {
  it('names jobs by title, then readable file name, then job number', () => {
    expect(nameFromFile('gearbox_housing_v3.gcode')).toBe('Gearbox housing v3');
    expect(nameFromFile('sensor_bracket.gcode.3mf')).toBe('Sensor bracket');
    expect(nameFromFile('notes.v2.txt')).toBe('Notes.v2');
    expect(displayName({ title: 'Bracket', fileName: 'x.gcode', displayId: 'J-1' })).toBe('Bracket');
    expect(displayName({ title: null, fileName: 'gearbox_housing_v3.gcode', displayId: 'J-1' })).toBe('Gearbox housing v3');
    expect(displayName({ displayId: 'J-1' })).toBe('J-1');
    expect(workItemName({ kind: 'print', fileName: 'gearbox_housing_v3.gcode', displayId: 'P-1' })).toBe('gearbox_housing_v3.gcode');
    expect(workItemSecondaryIds({ kind: 'print', fileName: 'a.gcode', displayId: 'P-1' })).toEqual(['P-1', 'Unlinked']);
    expect(workItemSecondaryIds({ kind: 'job', title: null, fileName: 'gearbox_housing_v3.gcode', displayId: 'J-1' })).toEqual(['J-1', 'gearbox_housing_v3.gcode']);
  });

  it('formats prices, durations and adjustments like the prototype', () => {
    expect(formatMoney('5')).toBe('€5.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatDuration(7500)).toBe('2 h 5 min');
    expect(formatDuration(600)).toBe('10 min');
    expect(adjustmentSummary({ kind: 'discount_percent', value: '20.00' })).toBe('Discount 20 %');
    expect(adjustmentSummary({ kind: 'multiplier', value: '0.6700' })).toBe('Multiplier ×0.67');
    expect(adjustmentSummary({ kind: 'fixed', value: '5.00' })).toBe('Fixed price €5.00');
  });

  it('reports connector issues only for disconnected or degraded connectors', () => {
    expect(connectorIssue({ runtimeState: 'degraded', runtimeErrorCode: 'E42' })).toBe('Connector degraded · E42');
    expect(connectorIssue({ runtimeState: 'connected' })).toBeNull();
    expect(connectorIssue(null)).toBeNull();
  });

  it('offers every unified status and billing state as a filter option', () => {
    expect(jobRowStatusOptions.map((option) => option.id)).toEqual(['running', 'printing', 'unlinked', 'needs_outcome', 'successful', 'partial_failure', 'failed', 'cancelled']);
    expect(billingStateOptions.map((option) => option.id)).toEqual(['on_order', 'order_outdated', 'not_on_order', 'price_incomplete', 'pending']);
  });

  it('builds production paths for the prototype links', () => {
    expect(machineLogbookPaths.jobs()).toBe('/machine-logbook/jobs');
    expect(machineLogbookPaths.jobs({ status: 'unlinked', q: undefined })).toBe('/machine-logbook/jobs?status=unlinked');
    expect(machineLogbookPaths.print('p1')).toBe('/machine-logbook/jobs/prints/p1');
    expect(machineLogbookPaths.machine('m1', 'printer')).toBe('/machine-logbook/machines/m1?tab=printer');
    expect(machineLogbookPaths.inventory('spools')).toBe('/machine-logbook/inventory?tab=spools');
    expect(machineLogbookPaths.material('a')).toBe('/machine-logbook/inventory/materials/a');
    expect(machineLogbookPaths.spool('s')).toBe('/machine-logbook/inventory/spools/s');
    expect(machineLogbookPaths.statistics()).toBe('/machine-logbook/statistics');
  });

  it('detects whether linking a print changes the manual run', () => {
    const job = { startsAt: '2026-09-15T08:00:00Z', durationSeconds: 3600, usages: [{ quantity: '20.000', materialName: 'PLA' }] } as MachineJob;
    const print = { startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T09:00:00Z', reportedUsage: { quantity: '20', quantityBasis: 'actual', materialName: 'PLA' } } as Print;
    expect(replaceChangesAnything(job, print)).toBe(false);
    expect(replaceChangesAnything(job, { ...print, endedAt: '2026-09-15T09:30:00Z' })).toBe(true);
  });
});

function Can() {
  const can = useCan();
  return <p>{can('machine_jobs.edit') ? 'may edit' : 'may not edit'}</p>;
}

describe('useCan', () => {
  it('answers from the current user permissions', () => {
    auth.permissions = [PermissionId.machine_jobsedit];
    const first = renderRoute(<Can />);
    expect(screen.getByText('may edit')).toBeInTheDocument();
    first.unmount();
    auth.permissions = [PermissionId.machine_jobsread];
    renderRoute(<Can />);
    expect(screen.getByText('may not edit')).toBeInTheDocument();
  });
});

describe('QueryBoundary', () => {
  function Boundary({ fail }: { fail: boolean }) {
    const query = useQuery({ queryKey: ['boundary', fail], queryFn: () => fail ? Promise.reject(new Error('x')) : Promise.resolve('loaded value') });
    return <QueryBoundary query={query}>{(data) => <p>{data}</p>}</QueryBoundary>;
  }

  it('shows the data once loaded', async () => {
    renderRoute(<Boundary fail={false} />);
    expect(await screen.findByText('loaded value')).toBeInTheDocument();
  });

  it('shows an error with a retry', async () => {
    renderRoute(<Boundary fail />);
    expect(await screen.findByText('The data could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

type Row = { id: string; name: string };
const columns: Column<Row>[] = [{ key: 'name', header: 'Name', render: (row) => row.name, sortValue: (row) => row.name }];

function ServerTable({ onState }: { onState: (state: { search: string; page: number; pageSize: number; sort: string }) => void }) {
  const state = useServerTableState('', { key: 'name', direction: 'DESC' }, [2, 5]);
  onState({ search: state.search, page: state.page, pageSize: state.pageSize, sort: `${state.sort.key}:${state.sort.direction}` });
  const all = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name) => ({ id: name, name }));
  const rows = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  return (
    <DirectoryTable
      mode="server" id="things" urlPrefix="" label="Things" columns={columns} rows={rows} total={all.length} sort={state.sort} onSortChange={state.setSort}
      empty={{ title: 'No things yet', description: 'Nothing here.' }} pageSizes={[2, 5]} searchDebounceMs={0}
    />
  );
}

describe('DirectoryTable', () => {
  it('server mode renders the given page, pages through the URL and reports sort and search', async () => {
    const onState = vi.fn();
    const user = userEvent.setup();
    const { router } = renderRoute(<ServerTable onState={onState} />, '/?page=2');

    const table = screen.getByRole('table', { name: 'Things' });
    expect(within(table).getByText('Gamma')).toBeInTheDocument();
    expect(within(table).queryByText('Alpha')).not.toBeInTheDocument();
    expect(onState).toHaveBeenLastCalledWith({ search: '', page: 2, pageSize: 2, sort: 'name:DESC' });

    await user.click(within(table).getByRole('button', { name: /Name/ }));
    await waitFor(() => expect(router.state.location.search).toContain('sort=name%3AASC'));
    expect(router.state.location.search).not.toContain('page=');

    await user.type(screen.getByRole('searchbox'), 'del');
    await waitFor(() => expect(router.state.location.search).toContain('q=del'));
  });

  it('client mode searches, sorts and pages the rows it is given', async () => {
    const user = userEvent.setup();
    const rows = ['Alpha', 'Beta', 'Gamma'].map((name) => ({ id: name, name }));
    renderRoute(
      <DirectoryTable id="things" label="Things" columns={columns} rows={rows} totalCount={3} searchText={(row) => row.name} defaultSort={{ key: 'name', direction: 'ASC' }} empty={{ title: 'No things yet', description: 'Nothing here.' }} />,
      '/?thingsq=gam',
    );
    const table = screen.getByRole('table', { name: 'Things' });
    expect(within(table).getByText('Gamma')).toBeInTheDocument();
    expect(within(table).queryByText('Alpha')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search input' }));
    expect(await within(table).findByText('Alpha')).toBeInTheDocument();
  });

  it('tells "nothing yet" from "nothing found"', () => {
    const empty = { title: 'No things yet', description: 'Nothing here.' };
    const first = renderRoute(<DirectoryTable id="things" label="Things" columns={columns} rows={[]} totalCount={0} searchText={() => ''} defaultSort={{ key: 'name', direction: 'ASC' }} empty={empty} />);
    expect(screen.getByText('No things yet')).toBeInTheDocument();
    first.unmount();
    renderRoute(<DirectoryTable id="things" label="Things" columns={columns} rows={[]} totalCount={4} searchText={() => ''} defaultSort={{ key: 'name', direction: 'ASC' }} empty={empty} />);
    expect(screen.getByText('No things found')).toBeInTheDocument();
  });
});

function LinkHarness({ job, print }: { job: Pick<MachineJob, 'id' | 'displayId' | 'run' | 'version'>; print: Pick<Print, 'id' | 'displayId'> }) {
  const [done, setDone] = useState(false);
  const { link, pending } = useLinkPrint(() => setDone(true));
  return (
    <>
      <button type="button" disabled={pending} onClick={() => { void link(print, job); }}>Link</button>
      {done && <p>done</p>}
    </>
  );
}

describe('useLinkPrint', () => {
  it('links with the loaded job version, confirms with a toast and then reports done', async () => {
    let body: unknown;
    server.use(http.put('*/api/v1/prints/print-1/job', async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    const user = userEvent.setup();
    renderRoute(<ToastProvider><LinkHarness print={{ id: 'print-1', displayId: 'P-00001' }} job={{ id: 'job-1', displayId: 'J-00001', run: 'manual', version: 7 }} /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('done')).toBeInTheDocument();
    expect(body).toEqual({ machineJobId: 'job-1', expectedJobVersion: 7 });
    expect(screen.getByText('Manual run replaced')).toBeInTheDocument();
    expect(screen.getByText('J-00001 now uses the data from P-00001.')).toBeInTheDocument();
  });
});
