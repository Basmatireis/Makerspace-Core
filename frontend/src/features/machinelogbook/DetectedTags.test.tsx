import type { ReactElement } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AddFilamentSpoolIdentifierRequest,
  CreateFilamentSpoolRequest,
  DetectedSpoolTag,
  FilamentSpool,
  Material,
  ReceiveInventoryStockRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { DetectedTrayCell } from './components/DetectedTrayCell';
import { IdentifierModal } from './dialogs/IdentifierModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { TagsStep } from './dialogs/changeFilament/TagsStep';
import { useChangeFilamentWizard } from './dialogs/changeFilament/useChangeFilamentWizard';
import { ToastProvider } from './shared/toasts';
import { tray } from './printerTestData';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const BOTH = [PermissionId.machinesread, PermissionId.inventoryread, PermissionId.filament_spoolsmanage];
const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8d${String(n).padStart(3, '0')}`;

const detected = (overrides: Partial<DetectedSpoolTag> = {}): DetectedSpoolTag => ({
  machineId: id(1),
  machineName: 'Bambu H2D',
  unitExternalId: '0',
  unitLabel: 'AMS 2 Pro',
  trayExternalId: '0',
  slotId: id(2),
  slotName: 'Slot 1',
  inputUnitName: 'AMS A',
  tagUid: 'AABB0011',
  materialType: 'PLA',
  subBrand: 'PLA Basic',
  colorHex: 'CC0000',
  remainPercent: 80,
  observedAt: '2026-10-21T08:00:00Z',
  spool: null,
  ...overrides,
});

const spool = {
  id: id(20),
  displayId: 'S-2026-000001',
  identifiers: [],
  version: 1,
} as unknown as FilamentSpool;

function useTags(items: DetectedSpoolTag[]) {
  let requests = 0;
  server.use(
    http.get('*/api/v1/printers/detected-spool-tags', () => {
      requests += 1;
      return HttpResponse.json({ items });
    }),
  );
  return () => requests;
}

const renderUi = (ui: ReactElement) => renderRoute(<ToastProvider>{ui}</ToastProvider>);

describe('Detected tray tag UID', () => {
  it('shows the UID with a copy control only when the printer reports one', () => {
    renderUi(
      <>
        <DetectedTrayCell tray={tray('0', { empty: false, rfid: true, materialType: 'PLA', tagUid: 'AABB0011' })} />
        <DetectedTrayCell tray={tray('1', { empty: false, rfid: true, materialType: 'PETG' })} />
      </>,
    );
    expect(screen.getAllByText('AABB0011')).toHaveLength(1);
    expect(screen.getAllByText('Copy tag UID', { selector: '.cds--tooltip-content' })).toHaveLength(1);
  });
});

describe('Identifier modal detected tags', () => {
  it('fills the value from a detected tag and submits it', async () => {
    auth.permissions = BOTH;
    useTags([detected(), detected({ trayExternalId: '1', tagUid: 'CC22', spool: { id: id(99), displayId: 'S-9' } })]);
    let body: AddFilamentSpoolIdentifierRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${spool.id}/identifiers`, async ({ request }) => {
        body = (await request.json()) as AddFilamentSpoolIdentifierRequest;
        return HttpResponse.json(spool);
      }),
      http.get('*/api/v1/filament-spools', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
    );
    const user = userEvent.setup();
    renderUi(<IdentifierModal open onClose={vi.fn()} spool={spool} />);
    const dialog = await screen.findByRole('dialog', { name: /S-2026-000001/ });
    await user.click(await within(dialog).findByRole('combobox', { name: /Detected in a printer/ }));
    const taken = await screen.findByRole('option', { name: /CC22/ });
    expect(taken).toHaveTextContent('on S-9');
    await user.click(taken);
    expect(within(dialog).getByLabelText('Value')).toHaveValue('');
    await user.click(screen.getByRole('option', { name: /AABB0011/ }));
    expect(within(dialog).getByLabelText('Value')).toHaveValue('AABB0011');
    await user.click(within(dialog).getByRole('button', { name: 'Add identifier' }));
    await waitFor(() => expect(body).toEqual({ kind: 'nfc', value: 'AABB0011' }));
  });

  it('does not offer the picker or request tags without machines.read', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.filament_spoolsmanage];
    const requests = useTags([detected()]);
    renderUi(<IdentifierModal open onClose={vi.fn()} spool={spool} />);
    const dialog = await screen.findByRole('dialog', { name: /S-2026-000001/ });
    expect(within(dialog).getByLabelText('Value')).toBeInTheDocument();
    expect(within(dialog).queryByText('Detected in a printer')).not.toBeInTheDocument();
    expect(requests()).toBe(0);
  });

  it('says when nothing is detected', async () => {
    auth.permissions = BOTH;
    useTags([]);
    renderUi(<IdentifierModal open onClose={vi.fn()} spool={spool} />);
    expect(await screen.findByText(/No spool tags are detected/)).toBeInTheDocument();
  });
});

function TagsHarness() {
  const wizard = useChangeFilamentWizard({ open: true, onClose: vi.fn(), preselected: spool });
  return wizard.ready ? <TagsStep wizard={wizard} spool={spool} /> : null;
}

describe('Change filament tags step detected tags', () => {
  it('adds a picked detected tag as a new NFC identifier', async () => {
    auth.permissions = BOTH;
    useTags([detected()]);
    server.use(
      http.get('*/api/v1/filament-spools', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get('*/api/v1/materials', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' }),
      ),
    );
    const user = userEvent.setup();
    renderUi(<TagsHarness />);
    const picker = await screen.findByRole('combobox', { name: /Detected in a printer/ });
    await user.click(within(picker.closest('.cds--list-box') as HTMLElement).getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('option', { name: /AABB0011/ }));
    expect(screen.getByLabelText('Value')).toHaveValue('AABB0011');
    expect(await screen.findByText(/Add NFC tag AABB0011/)).toBeInTheDocument();
  });
});

const WITH_STOCK = [...BOTH, PermissionId.inventorymanage];

const filament = {
  id: id(30),
  name: 'PLA Basic · White · Bambu Lab',
  kind: 'filament',
  materialTypeId: id(31),
  materialTypeName: 'PLA',
  unit: 'g',
  active: true,
  packageSize: '1000',
  quantity: '2000',
  assignedQuantity: '0',
  unassignedQuantity: '2000',
  inventoryVersion: 4,
  version: 1,
} as unknown as Material;

const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function serveInventory() {
  server.use(
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([filament]), totalInventoryValue: '0' })),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] }),
    ),
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page([]))),
  );
}

async function pickDetected(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(dialog).findByRole('combobox', { name: /Detected in a printer/ }));
  await user.click(await screen.findByRole('option', { name: /AABB0011/ }));
}

describe('Receive stock detected tags', () => {
  it('fills the identifier of a new spool from a detected tag', async () => {
    auth.permissions = WITH_STOCK;
    useTags([detected()]);
    serveInventory();
    let body: ReceiveInventoryStockRequest | undefined;
    server.use(
      http.post('*/api/v1/inventory/receipts', async ({ request }) => {
        body = (await request.json()) as ReceiveInventoryStockRequest;
        return HttpResponse.json({ material: filament, spools: [], transactions: [] }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderUi(<ReceiveStockModal open onClose={vi.fn()} kind="filament" article={filament} />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '20');
    await user.click(within(dialog).getByLabelText('On new spools (one per package)'));
    await pickDetected(dialog, user);
    expect(within(dialog).getByLabelText('Identifier value (optional)')).toHaveValue('AABB0011');
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));
    await waitFor(() =>
      expect(body?.placement).toMatchObject({
        mode: 'new_spools',
        identifiers: [{ kind: 'nfc', value: 'AABB0011' }],
      }),
    );
  });
});

describe('Spool form detected tags', () => {
  it('registers a spool with a detected tag on its first fill', async () => {
    auth.permissions = WITH_STOCK;
    useTags([detected()]);
    serveInventory();
    let body: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        body = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(spool, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderUi(<SpoolFormModal open onClose={vi.fn()} initialMaterialId={filament.id} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Register spool' })).toBeEnabled());
    await pickDetected(dialog, user);
    expect(within(dialog).getByLabelText('NFC tag (optional)')).toHaveValue('AABB0011');
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      stockMode: 'existing_stock',
      materialId: filament.id,
      identifiers: [{ kind: 'nfc', value: 'AABB0011' }],
    });
  });

  const loaded = {
    ...spool,
    fillId: id(21),
    materialId: filament.id,
    initialNetWeightG: '1000',
    lifecycle: 'active',
    identifiers: [],
  } as unknown as FilamentSpool;

  it('adds a detected tag to the current fill before saving an edited spool', async () => {
    auth.permissions = WITH_STOCK;
    useTags([detected()]);
    serveInventory();
    const calls: string[] = [];
    let added: AddFilamentSpoolIdentifierRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${loaded.id}/identifiers`, async ({ request }) => {
        calls.push('identifier');
        added = (await request.json()) as AddFilamentSpoolIdentifierRequest;
        return HttpResponse.json(loaded);
      }),
      http.patch(`*/api/v1/filament-spools/${loaded.id}`, () => {
        calls.push('update');
        return HttpResponse.json(loaded);
      }),
    );
    const user = userEvent.setup();
    renderUi(<SpoolFormModal open onClose={vi.fn()} spool={loaded} />);
    const dialog = await screen.findByRole('dialog', { name: `Edit ${loaded.displayId}` });
    await pickDetected(dialog, user);
    await user.click(within(dialog).getByRole('button', { name: 'Save spool' }));
    await waitFor(() => expect(calls).toEqual(['identifier', 'update']));
    expect(added).toEqual({ kind: 'nfc', value: 'AABB0011' });
  });

  it('keeps the spool unchanged when the tag is already in use', async () => {
    auth.permissions = WITH_STOCK;
    useTags([]);
    serveInventory();
    let updated = false;
    server.use(
      http.post(`*/api/v1/filament-spools/${loaded.id}/identifiers`, () =>
        HttpResponse.json({ code: 'identifier_in_use', message: 'In use' }, { status: 409 }),
      ),
      http.patch(`*/api/v1/filament-spools/${loaded.id}`, () => {
        updated = true;
        return HttpResponse.json(loaded);
      }),
    );
    const user = userEvent.setup();
    renderUi(<SpoolFormModal open onClose={vi.fn()} spool={loaded} />);
    const dialog = await screen.findByRole('dialog', { name: `Edit ${loaded.displayId}` });
    await user.type(within(dialog).getByLabelText('Add NFC tag (optional)'), 'TAKEN');
    await user.click(within(dialog).getByRole('button', { name: 'Save spool' }));
    expect(await within(dialog).findByText('This tag is already assigned to a spool.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Not saved')).not.toBeInTheDocument();
    expect(updated).toBe(false);
  });
});
