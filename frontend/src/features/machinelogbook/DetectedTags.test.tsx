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
import { bambuColorName } from './bambuColors';
import { DetectedSpoolsStrip } from './components/DetectedSpoolsStrip';
import { DetectedTrayCell } from './components/DetectedTrayCell';
import { suggestArticle } from './detectedSpools';
import { materialType } from './inventoryTestData';
import { IdentifierModal } from './dialogs/IdentifierModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { RegisterSpoolModal } from './dialogs/RegisterSpoolModal';
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
  productCode: null,
  filamentProfileId: null,
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

const WITH_STOCK = [...BOTH, PermissionId.inventorymanage];

const filament = {
  id: id(30),
  displayId: 'A-0030',
  name: 'PLA Basic · White · Bambu Lab',
  materialTypeCode: 'PLA',
  storageLocation: null,
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

describe('Register spool detected tags', () => {
  it('registers a spool with a tag a printer detects', async () => {
    auth.permissions = WITH_STOCK;
    useTags([detected()]);
    serveInventory();
    let body: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        body = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json({ ...spool, materialName: filament.name }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderUi(<RegisterSpoolModal open onClose={vi.fn()} initialMaterialId={filament.id} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
        'A-0030 · PLA Basic · White · Bambu Lab · 2,000 g loose',
      ),
    );
    await pickDetected(dialog, user);
    expect(within(dialog).getByLabelText('RFID tag UID (optional)')).toHaveValue('AABB0011');
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        materialId: filament.id,
        stockMode: 'existing_stock',
        identifiers: [{ kind: 'nfc', value: 'AABB0011' }],
      }),
    );
  });

  it('keeps the dialog open and marks the tag when it is already in use', async () => {
    auth.permissions = WITH_STOCK;
    useTags([]);
    serveInventory();
    server.use(
      http.post('*/api/v1/filament-spools', () =>
        HttpResponse.json({ code: 'identifier_in_use', message: 'in use' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderUi(<RegisterSpoolModal open onClose={vi.fn()} initialMaterialId={filament.id} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await user.type(within(dialog).getByLabelText('RFID tag UID (optional)'), 'TAKEN');
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
        'A-0030 · PLA Basic · White · Bambu Lab · 2,000 g loose',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    expect(await within(dialog).findByText('This tag is already assigned to a spool.')).toBeInTheDocument();
  });
});

const plaType = materialType({ id: id(31), code: 'PLA', name: 'PLA' });

/** An active PLA Basic article of the given colour. */
const basic = (n: number, colorHex: string | null, colorName: string | null = null): Material =>
  ({
    ...filament,
    id: id(n),
    displayId: `A-00${n}`,
    name: `PLA Basic · ${colorName ?? colorHex ?? 'no colour'} · Bambu Lab`,
    variant: 'Basic',
    colorHex,
    colorName,
  }) as Material;

describe('Detected spool suggestions', () => {
  const red = basic(40, '#CC0000', 'Red');

  it('calls an article of the same colour a match and a nearby one similar', () => {
    expect(suggestArticle(detected({ colorHex: 'CC0000' }), [red], [plaType])).toMatchObject({
      article: { id: red.id },
      match: 'same',
      colorHex: '#CC0000',
    });
    expect(suggestArticle(detected({ colorHex: 'CC1010' }), [red], [plaType]).match).toBe('same');
    expect(suggestArticle(detected({ colorHex: 'CC3333' }), [red], [plaType])).toMatchObject({
      article: { id: red.id },
      match: 'similar',
    });
    expect(suggestArticle(detected({ colorHex: '0000CC' }), [red], [plaType])).toMatchObject({
      article: null,
      match: null,
      type: { id: plaType.id },
      variant: 'Basic',
      colorHex: '#0000CC',
    });
  });

  it('names the colour from the product code, else from an article with exactly that colour', () => {
    expect(bambuColorName('A00-K0')).toBe('Black');
    expect(bambuColorName('a00-k00')).toBe('Black');
    expect(bambuColorName('A01-B0')).toBe('Sky Blue');
    expect(bambuColorName('A18-B0')).toBe('Cyan');
    expect(bambuColorName('Z99-K0')).toBeNull();
    expect(bambuColorName(null)).toBeNull();
    const named = suggestArticle(detected({ colorHex: '000000', productCode: 'A00-K0' }), [red], [plaType]);
    expect(named.colorName).toBe('Black');
    expect(suggestArticle(detected({ colorHex: 'CC0000' }), [red], [plaType]).colorName).toBe('Red');
    expect(suggestArticle(detected({ colorHex: 'CC3333' }), [red], [plaType]).colorName).toBeNull();
  });
});

describe('Detected spools strip', () => {
  it('labels the suggestion by colour match and shows the reported colour next to it', async () => {
    auth.permissions = BOTH;
    useTags([
      detected({ trayExternalId: '0', tagUid: 'SAME', colorHex: 'CC0000' }),
      detected({ trayExternalId: '1', tagUid: 'NEAR', colorHex: 'CC3333' }),
      detected({ trayExternalId: '2', tagUid: 'FAR', colorHex: '0000CC', productCode: 'A00-B9' }),
    ]);
    server.use(http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType] })));
    renderUi(<DetectedSpoolsStrip materials={[basic(40, '#CC0000', 'Red')]} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const [same, near, far] = rows;
    expect(within(same).getByText('Match')).toBeInTheDocument();
    expect(within(same).getByRole('img', { name: 'Colour #CC0000 reported' })).toBeInTheDocument();
    expect(within(near).getByText('Similar colour')).toBeInTheDocument();
    expect(within(near).queryByText('Match')).not.toBeInTheDocument();
    expect(within(near).getByText('#CC3333 reported')).toBeInTheDocument();
    expect(within(far).getByText('New article')).toBeInTheDocument();
    // The reported sub-brand and the type and variant of the new article.
    expect(within(far).getAllByText('PLA Basic')).toHaveLength(2);
    expect(within(far).getByText('#0000CC reported')).toBeInTheDocument();
    expect(within(far).getByText('#0000CC Blue')).toBeInTheDocument();
  });
});

describe('Register spool from a detection', () => {
  it('prefills the new article with the reported colour and its official name', async () => {
    auth.permissions = WITH_STOCK;
    useTags([]);
    serveInventory();
    server.use(http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType] })));
    renderUi(
      <RegisterSpoolModal
        open
        onClose={vi.fn()}
        detected={detected({ colorHex: '000000', productCode: 'A00-K0', slotId: null, slotName: null })}
      />,
    );
    // With a detection the dialog is named after its label, "Detected in <slot>".
    const dialog = await screen.findByRole('dialog', { name: /Detected in Bambu H2D/ });
    await waitFor(() => expect(within(dialog).getByLabelText('Colour name (optional)')).toHaveValue('Black'));
    expect(within(dialog).getByLabelText('Colour code (optional)')).toHaveValue('#000000');
    expect(within(dialog).getByRole('combobox', { name: 'Variant (optional)' })).toHaveValue('Basic');
    expect(within(dialog).getByText(/PLA Basic #000000 Black/)).toBeInTheDocument();
  });
});
