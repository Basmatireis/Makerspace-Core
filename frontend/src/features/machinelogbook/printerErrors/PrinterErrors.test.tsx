import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  PermissionId,
  type PrinterErrorCode,
  type PrinterErrorCodeList,
  type PrinterErrorCodeSync,
  type PrinterErrorOccurrence,
  type PrinterLiveStatusError,
  type PrinterNotificationSettings,
} from '../../../api/generated/models';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';
import { PrinterPanel } from '../components/connectorDiagnostics/PrinterPanel';
import { assignmentOf, liveStatusOf, printerId, templateProfile } from '../printerTestData';
import { MachinesPage } from '../MachinesPage';
import { ToastProvider } from '../shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const fatal: PrinterLiveStatusError = {
  sourceFamily: 'hms',
  code: '0300-0D00-0001-0001',
  observedAt: null,
  severity: 'fatal',
  title: 'Heatbed temperature abnormal',
  link: 'https://wiki.bambulab.com/en/hms/0300-0D00-0001-0001',
};
const printError: PrinterLiveStatusError = { sourceFamily: 'print', code: '07FF8003', observedAt: null };
const notice: PrinterLiveStatusError = {
  sourceFamily: 'hms',
  code: '0700-2000-0002-0001',
  observedAt: null,
  severity: 'common',
  title: null,
  link: null,
};

const occurrence = (overrides: Partial<PrinterErrorOccurrence> = {}): PrinterErrorOccurrence => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8e001',
  sourceFamily: 'hms',
  code: '0300-0D00-0001-0001',
  severity: 'fatal',
  title: 'Heatbed temperature abnormal',
  description: null,
  link: null,
  firstObservedAt: '2026-10-30T10:00:00Z',
  lastObservedAt: '2026-10-30T10:05:00Z',
  resolvedAt: '2026-10-30T10:06:00Z',
  runId: null,
  ...overrides,
});

function renderPanel(errors: PrinterLiveStatusError[], history: PrinterErrorOccurrence[] = []) {
  const live = liveStatusOf({ errors });
  const calls = { cleared: 0, put: [] as unknown[] };
  server.use(
    http.get(`*/api/v1/machines/${printerId}/printer/live-status`, () => HttpResponse.json(live)),
    http.get(`*/api/v1/machines/${printerId}/printer`, () => HttpResponse.json(templateProfile())),
    http.get('*/api/v1/printer-connectors/*/observed-runs', () => HttpResponse.json({ items: [] })),
    http.get(`*/api/v1/machines/${printerId}/printer-errors`, () => HttpResponse.json({ items: history })),
    http.delete(`*/api/v1/machines/${printerId}/printer-errors`, () => {
      calls.cleared += 1;
      return new HttpResponse(null, { status: 204 });
    }),
    http.put('*/api/v1/printer-error-codes/:family/:code', async ({ request, params }) => {
      calls.put.push({ family: params.family, code: params.code, body: await request.json() });
      return HttpResponse.json({ id: 'x', updatedAt: '2026-10-30T10:00:00Z', ...(calls.put.at(-1) as object) });
    }),
  );
  renderRoute(
    <ToastProvider>
      <PrinterPanel view={{ assignment: assignmentOf(), live, stale: false, issue: null }} events={[]} active />
    </ToastProvider>,
  );
  return calls;
}

describe('Printer errors on the printer panel', () => {
  it('shows real problems with severity, meaning and a safe link and hides notices behind a toggle', async () => {
    auth.permissions = [PermissionId.machinesread];
    renderPanel([fatal, printError, notice]);
    expect(await screen.findByText('0300-0D00-0001-0001')).toBeInTheDocument();
    expect(screen.getByText('Fatal')).toBeInTheDocument();
    expect(screen.getByText('Print error')).toBeInTheDocument();
    expect(screen.getByText('Heatbed temperature abnormal')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', fatal.link);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText('0700-2000-0002-0001')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show notices (1)' }));
    expect(screen.getByText('0700-2000-0002-0001')).toBeInTheDocument();
    expect(screen.getByText('Common')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide notices (1)' }));
    expect(screen.queryByText('0700-2000-0002-0001')).not.toBeInTheDocument();
  });

  it('offers adding a meaning only with machines.manage and saves it for the code', async () => {
    auth.permissions = [PermissionId.machinesread, PermissionId.machinesmanage];
    const calls = renderPanel([printError]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add meaning for 07FF8003' }));
    const dialog = await screen.findByRole('dialog', { name: 'Printer error meaning' });
    await user.type(within(dialog).getByLabelText('Meaning'), 'Nozzle clogged');
    await user.type(within(dialog).getByLabelText(/Link/), 'https://example.org/clog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.put).toEqual([
        {
          family: 'print',
          code: '07FF8003',
          body: { title: 'Nozzle clogged', description: '', link: 'https://example.org/clog' },
        },
      ]),
    );
  });

  it('does not offer adding a meaning without machines.manage', async () => {
    auth.permissions = [PermissionId.machinesread];
    renderPanel([printError]);
    expect(await screen.findByText('No meaning recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add meaning/ })).not.toBeInTheDocument();
  });

  it('lists the history and clears it after confirmation', async () => {
    auth.permissions = [PermissionId.machinesread, PermissionId.machinesmanage];
    const calls = renderPanel([], [occurrence()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Error history \(1\)/ }));
    const table = await screen.findByRole('table', { name: 'Printer error history' });
    expect(within(table).getByText('0300-0D00-0001-0001')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear history' }));
    const dialog = await screen
      .findByRole('alertdialog', { name: 'Clear error history?' })
      .catch(() => screen.findByRole('dialog', { name: 'Clear error history?' }));
    expect(calls.cleared).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(calls.cleared).toBe(1));
  });

  it('hides the history without machines.read', async () => {
    auth.permissions = [PermissionId.printer_connectorsread];
    renderPanel([]);
    expect(await screen.findByText('No errors reported.')).toBeInTheDocument();
    expect(screen.queryByText('Error history')).not.toBeInTheDocument();
  });
});

describe('Printer settings tabs', () => {
  const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8f001';
  const settings: PrinterNotificationSettings = {
    errorRoleId: null,
    errorRoleName: null,
    errorMinSeverity: 'serious',
    version: 3,
    updatedAt: '2026-10-30T09:00:00Z',
  };
  const code = (overrides: Partial<PrinterErrorCode> = {}): PrinterErrorCode => ({
    id: '0192f6f8-743e-7c77-a349-cd07c3e8e101',
    sourceFamily: 'print',
    code: '07FF8003',
    title: 'Nozzle clogged',
    description: 'Clean the nozzle.',
    link: null,
    source: 'manual',
    updatedAt: '2026-10-30T09:00:00Z',
    ...overrides,
  });
  const syncState = (overrides: Partial<PrinterErrorCodeSync> = {}): PrinterErrorCodeSync => ({
    enabled: true,
    lastAttemptAt: '2026-10-31T03:00:00Z',
    lastSuccessAt: '2026-10-31T03:00:00Z',
    lastError: null,
    importedCount: 12,
    ...overrides,
  });
  const codeList = (items: PrinterErrorCode[], sync = syncState()): PrinterErrorCodeList => ({
    items,
    page: 1,
    pageSize: 25,
    total: items.length,
    sync,
  });
  const serveBase = () =>
    server.use(
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/processes', () => HttpResponse.json({ items: [] })),
    );
  const renderTab = (tab: string) =>
    renderRoute(
      <ToastProvider>
        <MachinesPage />
      </ToastProvider>,
      `/workshop/machines?tab=${tab}`,
    );

  it('saves the notified role and level with the version it loaded', async () => {
    auth.permissions = [PermissionId.machinesmanage, PermissionId.rolesread];
    serveBase();
    let body: unknown;
    server.use(
      http.get('*/api/v1/printer-notification-settings', () => HttpResponse.json(settings)),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({
          items: [{ id: roleId, name: 'Printer wardens', description: '', system: false, permissions: [] }],
          nextCursor: null,
        }),
      ),
      http.put('*/api/v1/printer-notification-settings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...settings, errorRoleId: roleId, errorMinSeverity: 'common', version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderTab('notifications');
    const roleBox = await screen.findByRole('combobox', { name: 'Also notify this role' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(roleBox);
    await user.click(await screen.findByText('Printer wardens'));
    await user.click(screen.getByRole('combobox', { name: /Notify from/ }));
    await user.click(await screen.findByText(/^Common:/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ errorRoleId: roleId, errorMinSeverity: 'common', expectedVersion: 3 }));
  });

  it('adds a code to the catalog and edits an existing one', async () => {
    auth.permissions = [PermissionId.machinesmanage];
    serveBase();
    const puts: { family: unknown; code: unknown; body: unknown }[] = [];
    server.use(
      http.get('*/api/v1/printer-error-codes', () => HttpResponse.json(codeList([code()]))),
      http.put('*/api/v1/printer-error-codes/:family/:code', async ({ request, params }) => {
        puts.push({ family: params.family, code: params.code, body: await request.json() });
        return HttpResponse.json(code());
      }),
    );
    const user = userEvent.setup();
    renderTab('catalog');
    const table = await screen.findByRole('table', { name: 'Printer error catalog' });
    expect(within(table).getByText('Nozzle clogged')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add code' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add error code' });
    await user.type(within(dialog).getByLabelText('Code'), '0300-0d00-0001-0002');
    await user.type(within(dialog).getByLabelText('Meaning'), 'Bed sensor open');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts).toEqual([
        {
          family: 'hms',
          code: '0300-0D00-0001-0002',
          body: { title: 'Bed sensor open', description: '', link: null },
        },
      ]),
    );

    const trigger = screen
      .getByText('Actions for 07FF8003', { selector: '.cds--tooltip-content' })
      .closest('.cds--popover-container')!
      .querySelector('button') as HTMLElement;
    await user.click(trigger);
    await user.click(await screen.findByText('Edit', { selector: '.cds--overflow-menu-options__option-content' }));
    dialog = await screen.findByRole('dialog', { name: 'Printer error meaning' });
    expect(within(dialog).getByLabelText('Code')).toBeDisabled();
    const title = within(dialog).getByLabelText('Meaning');
    await user.clear(title);
    await user.type(title, 'Nozzle blocked');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts[1]).toEqual({
        family: 'print',
        code: '07FF8003',
        body: { title: 'Nozzle blocked', description: 'Clean the nozzle.', link: null },
      }),
    );
  });

  it('shows the fetch status, with and without a last error', async () => {
    auth.permissions = [PermissionId.machinesmanage];
    serveBase();
    server.use(http.get('*/api/v1/printer-error-codes', () => HttpResponse.json(codeList([code()]))));
    const view = renderTab('catalog');
    expect(
      await screen.findByText(/Meanings are fetched from Bambu Lab's published list daily\. Last fetched/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(12 codes\)/)).toBeInTheDocument();
    expect(screen.queryByText(/The last fetch failed/)).not.toBeInTheDocument();
    view.unmount();

    server.use(
      http.get('*/api/v1/printer-error-codes', () =>
        HttpResponse.json(codeList([], syncState({ lastSuccessAt: null, lastError: 'HTTP 503', importedCount: 0 }))),
      ),
    );
    renderTab('catalog');
    expect(await screen.findByText(/Not fetched yet\./)).toBeInTheDocument();
    expect(screen.getByText('The last fetch failed: HTTP 503')).toBeInTheDocument();
  });

  it('says the fetch is off and disables Fetch now', async () => {
    auth.permissions = [PermissionId.machinesmanage];
    serveBase();
    server.use(
      http.get('*/api/v1/printer-error-codes', () =>
        HttpResponse.json(codeList([], syncState({ enabled: false, lastSuccessAt: null }))),
      ),
    );
    renderTab('catalog');
    expect(
      await screen.findByText(/Automatic fetching is off \(PRINTER_ERROR_CODE_SOURCE_URL is empty\)\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch now' })).toBeDisabled();
  });

  it('reloads the list after Fetch now and shows a failure message', async () => {
    auth.permissions = [PermissionId.machinesmanage];
    serveBase();
    let fail = false;
    let fetched = false;
    server.use(
      http.get('*/api/v1/printer-error-codes', () =>
        HttpResponse.json(
          fetched
            ? codeList(
                [
                  code({
                    id: '0192f6f8-743e-7c77-a349-cd07c3e8e102',
                    code: '0500-0100',
                    title: 'Fetched meaning',
                    source: 'bambu',
                  }),
                ],
                syncState({ importedCount: 1 }),
              )
            : codeList([code()]),
        ),
      ),
      http.post('*/api/v1/printer-error-codes/sync', () => {
        if (fail)
          return HttpResponse.json(
            { code: 'sync_failed', message: 'Bambu Lab could not be reached.' },
            { status: 502 },
          );
        fetched = true;
        return HttpResponse.json(syncState({ importedCount: 1 }));
      }),
    );
    const user = userEvent.setup();
    renderTab('catalog');
    const catalogTable = () => screen.getByRole('table', { name: 'Printer error catalog' });
    await screen.findByRole('table', { name: 'Printer error catalog' });
    expect(within(catalogTable()).getByText('Edited here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fetch now' }));
    expect(await screen.findByText('Fetched meaning')).toBeInTheDocument();
    expect(within(catalogTable()).queryByText('Nozzle clogged')).not.toBeInTheDocument();
    expect(within(catalogTable()).getByText('Bambu Lab')).toBeInTheDocument();
    expect(await screen.findByText(/\(1 codes\)/)).toBeInTheDocument();

    fail = true;
    await user.click(screen.getByRole('button', { name: 'Fetch now' }));
    expect(await screen.findByText('Bambu Lab could not be reached.')).toBeInTheDocument();
  });

  it('pages and searches the catalog on the server', async () => {
    auth.permissions = [PermissionId.machinesmanage];
    serveBase();
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('*/api/v1/printer-error-codes', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ...codeList([
            code(),
            code({ id: '0192f6f8-743e-7c77-a349-cd07c3e8e103', code: '07FF8004', title: 'Bed loose' }),
          ]),
          total: 60,
        });
      }),
    );
    const user = userEvent.setup();
    renderTab('catalog');
    const table = await screen.findByRole('table', { name: 'Printer error catalog' });
    expect(within(table).getByText('Nozzle clogged')).toBeInTheDocument();
    expect(within(table).getByText('Bed loose')).toBeInTheDocument();
    expect(screen.getByText(/of 60 items/)).toBeInTheDocument();
    expect(requests[0].get('page')).toBe('1');
    expect(requests[0].get('pageSize')).toBe('10');
    expect(requests[0].has('search')).toBe(false);

    await user.type(screen.getByPlaceholderText('Search printer error catalog'), 'nozzle');
    await waitFor(() => expect(requests.some((params) => params.get('search') === 'nozzle')).toBe(true));
  });

  it('offers the new tabs only with machines.manage', async () => {
    auth.permissions = [PermissionId.machinesread];
    serveBase();
    renderTab('machines');
    expect(await screen.findByRole('tab', { name: 'Processes' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Printer notifications' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Error catalog' })).not.toBeInTheDocument();
  });
});
