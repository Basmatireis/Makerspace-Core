import type {
  CreateMaterialRequest,
  FilamentSpool,
  InventoryTransaction,
  Material,
  MaterialType,
  ReceiveInventoryStockRequest,
} from '../../../../api/generated/models';
import { created, fail, notFound, ok, paged, type DemoRouter } from '../router';
import { decimal, money, nextId, nextReference, toCents, type DemoStore } from '../store';

const lower = (value: unknown) => String(value ?? '').toLowerCase();

function stockState(material: Material): Material['stockState'] {
  const quantity = Number(material.quantity);
  if (quantity <= 0) return 'empty';
  return quantity <= Number(material.lowStockThreshold ?? 0) ? 'low_stock' : 'in_stock';
}

function createMaterial(store: DemoStore, request: CreateMaterialRequest): Material | undefined {
  const type: MaterialType | undefined = store.materialTypes.find((item) => item.id === request.materialTypeId);
  if (!type) return undefined;
  const variant = type.variants.find((item) => item.name === request.variant);
  const stamp = store.now.toISOString();
  const name =
    request.name?.trim() || [type.name, request.variant, request.colorName].filter(Boolean).join(' ') || type.name;
  const material: Material = {
    id: nextId(store),
    displayId: nextReference(store, 'M', 4),
    name,
    kind: type.kind,
    materialTypeId: type.id,
    materialTypeName: type.name,
    materialTypeCode: type.code,
    machineUse: type.machineUse,
    variantId: variant?.id ?? null,
    variant: request.variant ?? null,
    manufacturer: request.manufacturer ?? null,
    packageSize: request.packageSize ?? null,
    storageLocation: request.storageLocation ?? null,
    notes: request.notes ?? null,
    colorName: request.colorName ?? null,
    colorHex: request.colorHex ?? null,
    unit: request.unit ?? type.unit,
    dimension: type.dimension,
    countLabel: request.countLabel ?? null,
    active: true,
    lowStockThreshold: request.lowStockThreshold ?? null,
    quantity: '0.000',
    assignedQuantity: '0.000',
    unassignedQuantity: '0.000',
    filamentDiameterMm: request.filamentDiameterMm ?? null,
    averageUnitCost: '0.0000',
    inventoryValue: '0.00',
    stockState: 'empty',
    inventoryVersion: 1,
    recentConsumption: '0.000',
    prices: [],
    attention: [],
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  type.materialCount += 1;
  store.materials.push(material);
  return material;
}

function receive(store: DemoStore, request: ReceiveInventoryStockRequest) {
  const material =
    store.materials.find((item) => item.id === request.materialId) ??
    (request.material ? createMaterial(store, request.material) : undefined);
  if (!material) return fail(422, 'invalid_material', 'Choose a material or describe a new one.');
  const packageSize = Number(request.packageSize ?? material.packageSize ?? 1);
  const added = packageSize * request.packageCount;
  const cents = toCents(request.totalPrice);
  const oldValue = Number(material.inventoryValue);
  const quantity = Number(material.quantity) + added;
  const value = oldValue + cents / 100;
  material.quantity = decimal(quantity);
  material.unassignedQuantity = decimal(Number(material.unassignedQuantity) + added);
  material.inventoryValue = decimal(value, 2);
  material.averageUnitCost = decimal(quantity ? value / quantity : 0, 4);
  material.stockState = stockState(material);
  material.attention = material.stockState === 'low_stock' ? material.attention : [];
  material.inventoryVersion += 1;
  material.version += 1;
  const transaction: InventoryTransaction = {
    id: nextId(store),
    materialId: material.id,
    kind: 'purchase',
    quantityDelta: decimal(added),
    unitAcquisitionCost: decimal(added ? cents / 100 / added : 0, 4),
    inventoryValueDelta: decimal(cents / 100, 2),
    totalPurchasePrice: money(cents),
    occurredAt: request.occurredAt,
    supplier: request.supplier ?? null,
    note: request.note ?? null,
    reference: request.reference ?? null,
    actorName: `${store.user.person.firstName} ${store.user.person.lastName}`,
    createdAt: store.now.toISOString(),
  };
  store.transactions.push(transaction);
  const spools: FilamentSpool[] = [];
  if (material.kind === 'filament' && request.placement?.mode === 'new_spools') {
    for (let index = 0; index < request.packageCount; index += 1) {
      const stamp = store.now.toISOString();
      const spool: FilamentSpool = {
        id: nextId(store),
        displayId: nextReference(store, 'SP', 3),
        materialId: material.id,
        materialDisplayId: material.displayId,
        materialName: material.name,
        materialTypeName: material.materialTypeName,
        colorName: material.colorName,
        colorHex: material.colorHex,
        manufacturer: material.manufacturer,
        unit: 'g',
        initialNetWeightG: decimal(packageSize, 0),
        remainingQuantity: decimal(packageSize, 1),
        tareWeightG: request.placement.tareWeightG ?? null,
        acquiredOn: request.occurredAt.slice(0, 10),
        acquisitionReference: request.reference ?? null,
        storageLocation: request.placement.storageLocation ?? material.storageLocation ?? null,
        notes: null,
        lifecycle: 'active',
        archivedAt: null,
        retiredOutcome: null,
        retiredQuantity: null,
        retiredByName: null,
        mounted: false,
        mountedOn: null,
        identifiers: [],
        attention: [],
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      spools.push(spool);
      store.spools.push(spool);
    }
    material.assignedQuantity = decimal(Number(material.assignedQuantity) + added);
    material.unassignedQuantity = decimal(Number(material.unassignedQuantity) - added);
  }
  return created({ material, spools, transactions: [transaction] });
}

export function registerInventory(router: DemoRouter<DemoStore>): void {
  router
    .get('/material-types', ({ store }) => ok({ items: store.materialTypes }))
    .get('/material-types/{materialTypeId}', ({ store, params }) => {
      const type = store.materialTypes.find((item) => item.id === params.materialTypeId);
      return type ? ok(type) : notFound('Material type');
    })
    .get('/materials', ({ store, query }) => {
      const search = lower(query.get('search'));
      const items = store.materials.filter(
        (material) =>
          (!search || lower(`${material.name} ${material.displayId}`).includes(search)) &&
          (!query.get('materialTypeId') || material.materialTypeId === query.get('materialTypeId')) &&
          (!query.get('kind') || material.kind === query.get('kind')) &&
          (!query.get('stockState') || material.stockState === query.get('stockState')),
      );
      const total = items.reduce((sum, material) => sum + Number(material.inventoryValue), 0);
      return ok(paged(items, query, { totalInventoryValue: decimal(total, 2) }));
    })
    .get('/materials/{materialId}', ({ store, params }) => {
      const material = store.materials.find((item) => item.id === params.materialId);
      return material ? ok(material) : notFound('Material');
    })
    .get('/materials/{materialId}/transactions', ({ store, params, query }) =>
      ok(
        paged(
          store.transactions
            .filter((item) => item.materialId === params.materialId)
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
          query,
        ),
      ),
    )
    .get('/inventory/suggestions', ({ store }) => {
      const unique = (values: (string | null | undefined)[]) => [
        ...new Set(values.filter((value): value is string => !!value)),
      ];
      return ok({
        variants: unique(store.materials.map((item) => item.variant)),
        manufacturers: unique(store.materials.map((item) => item.manufacturer)),
        suppliers: unique(store.transactions.map((item) => item.supplier)),
        storageLocations: unique(store.materials.map((item) => item.storageLocation)),
      });
    })
    .get('/inventory/recycle-bin', () => ok({ materials: [], spools: [], ledgerEntries: [] }))
    .get('/filament-spools', ({ store, query }) => {
      const search = lower(query.get('search'));
      const items = store.spools.filter(
        (spool) =>
          (!query.get('lifecycle') || spool.lifecycle === query.get('lifecycle')) &&
          (!query.get('materialId') || spool.materialId === query.get('materialId')) &&
          (!search || lower(`${spool.displayId} ${spool.materialName}`).includes(search)),
      );
      return ok(paged(items, query));
    })
    .get('/filament-spools/{spoolId}', ({ store, params }) => {
      const spool = store.spools.find((item) => item.id === params.spoolId);
      return spool ? ok(spool) : notFound('Spool');
    })
    .get('/filament-spools/{spoolId}/transactions', ({ query }) => ok(paged([], query)))
    .add(
      'POST',
      '/inventory/receipts',
      ({ store, body }) => {
        const request = body as unknown as ReceiveInventoryStockRequest;
        // Like the API: new spools additionally need filament_spools.manage.
        const rights = store.user.permissions as string[];
        if (request.placement?.mode === 'new_spools' && !rights.includes('filament_spools.manage')) {
          return fail(403, 'forbidden', 'You do not have permission to do this.');
        }
        return receive(store, request);
      },
      'inventory.receive',
    )
    .add(
      'POST',
      '/materials',
      ({ store, body }) => {
        const material = createMaterial(store, body as unknown as CreateMaterialRequest);
        return material ? created(material) : fail(422, 'invalid_material_type', 'Choose a material type.');
      },
      'inventory.articles.manage',
    );
}
