import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { changeFilamentSpoolFill } from '../../../../api/generated/filament-spools/filament-spools';
import type {
  FilamentNewFillInputSource,
  FilamentProduct,
  FilamentSpool,
  FilamentSpoolIdentifierKind,
  InventoryTransactionKind,
} from '../../../../api/generated/models';
import { decimalNumber, decimalText } from '../../../../app/decimalInput';
import {
  leftoverDefaults,
  resolveLeftover,
  saveTareWeight,
  toLeftoverInput,
  type LeftoverValues,
} from '../../components/LeftoverFields';
import { formatGrams, toDecimal, TransactionKindTag } from '../../components/inventoryShared';
import {
  identifierKey,
  identifierLabel,
  initialOf,
  needsRefill,
  remainingOf,
  spoolNameText,
  toNumber,
} from '../../components/spoolShared';
import { closeMaterialDelta, planClose } from '../../fillPlan';
import { useNotify } from '../../shared/toasts';
import { useCan } from '../../shared/useCan';
import { activeProductsQuery, allSpoolsQuery, filamentMaterialsQuery, useRefreshInventory } from '../../spoolData';
import { useLatestCallback } from '../../../../app/useLatestCallback';

export type Values = LeftoverValues & {
  spoolId: string;
  productId: string;
  manual: boolean;
  materialId: string;
  netWeight: string;
  source: FilamentNewFillInputSource;
  price: string;
  supplier: string;
  manufacturer: string;
  product: string;
  keep: Record<string, boolean>;
  added: { kind: FilamentSpoolIdentifierKind; value: string }[];
};

export type StepKey = 'spool' | 'leftover' | 'filament' | 'tags';
export const LABELS: Record<StepKey, string> = {
  spool: 'Spool',
  leftover: 'Leftover',
  filament: 'New filament',
  tags: 'Tags',
};
export const STEP_FIELDS: Record<StepKey, (keyof Values)[]> = {
  spool: ['spoolId'],
  leftover: ['grossWeight', 'tareWeight'],
  filament: ['productId', 'materialId', 'netWeight', 'price', 'source'],
  tags: [],
};

export const blankTag = (): Values['added'][number] => ({ kind: 'nfc', value: '' });
/** NFC tags are replaced with every refill; barcodes and QR codes stay on the spool. */
export const keepDefaults = (spool: FilamentSpool | undefined) =>
  Object.fromEntries((spool?.identifiers ?? []).map((item) => [item.id, item.kind !== 'nfc']));

/** Narrow screens stack the steps vertically. */
export function useNarrow() {
  const query = '(max-width: 41.98rem)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

export const entryText = (kind: InventoryTransactionKind, quantity: number, spool: string) => {
  const amount = formatGrams(Math.abs(quantity));
  if (kind === 'spool_transfer')
    return quantity >= 0 ? `${amount} loose stock → ${spool}` : `${amount} ${spool} → loose stock`;
  return `${quantity > 0 ? '+' : '−'}${amount}`;
};

/** State, queries and handlers of the refill workflow. */
export function useChangeFilamentWizard({
  open,
  onClose,
  preselected,
}: {
  open: boolean;
  onClose: () => void;
  preselected?: FilamentSpool;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const narrow = useNarrow();
  const can = useCan();
  const [step, setStep] = useState(0);
  const canPurchase = can('inventory.manage');
  const spoolList = useQuery({ ...allSpoolsQuery({ kind: 'reusable', lifecycle: 'active' }), enabled: open });
  const materialList = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const productList = useQuery({ ...activeProductsQuery(), enabled: open });
  const ready = spoolList.isSuccess && materialList.isSuccess && productList.isSuccess;
  const loadFailed = spoolList.isError || materialList.isError || productList.isError;
  const choices = spoolList.data ?? [];
  const filaments = (materialList.data ?? []).filter((material) => material.active);
  const products = (productList.data ?? []).filter((product) =>
    filaments.some((item) => item.id === product.materialId),
  );
  /**
   * Refilling the same filament is the common case, so the spool's current product is preselected — but only a
   * refill product, because a reusable spool is refilled from refills, not from filament sold on its own spool.
   */
  const defaults = (spool: FilamentSpool | undefined): Values => {
    const filled = Boolean(spool && !needsRefill(spool) && filaments.some((item) => item.id === spool.materialId));
    const current = filled ? products.find((item) => item.id === spool?.productId) : undefined;
    const product = current?.active && current.packaging === 'refill' ? current : undefined;
    return {
      ...leftoverDefaults(spool),
      spoolId: spool?.id ?? '',
      productId: product?.id ?? '',
      manual: filled && !current,
      materialId: product?.materialId ?? (filled && spool ? (spool.materialId ?? '') : ''),
      netWeight: product ? decimalText(product.netWeightG) : '1000',
      source: 'loose_stock',
      price: '',
      supplier: '',
      manufacturer: product?.manufacturer ?? (filled ? (spool?.manufacturer ?? '') : ''),
      product: product?.name ?? (filled ? (spool?.productName ?? '') : ''),
      keep: keepDefaults(spool),
      added: [blankTag()],
    };
  };
  const form = useForm<Values>({ defaultValues: defaults(preselected) });
  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    trigger,
    clearErrors,
    formState: { errors },
  } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'added' });
  const values = form.watch();
  const spool =
    preselected && preselected.id === values.spoolId ? preselected : choices.find((item) => item.id === values.spoolId);
  const refillOnly = spool ? needsRefill(spool) : false;
  const steps: StepKey[] = ['spool', ...(refillOnly ? [] : ['leftover' as const]), 'filament', 'tags'];
  const current = steps[Math.min(step, steps.length - 1)] ?? 'spool';
  const last = step >= steps.length - 1;

  const mutation = useMutation({
    mutationFn: async (data: Values) => {
      if (!spool || !material) throw new Error('spool or material missing');
      const version = refillOnly ? spool.version : await saveTareWeight(spool, data);
      return changeFilamentSpoolFill(spool.id, {
        leftover: refillOnly ? null : toLeftoverInput(spool, data),
        fill: {
          productId: data.manual ? null : data.productId || null,
          materialId: material.id,
          manufacturer: data.manufacturer.trim() || null,
          productName: data.product.trim() || null,
          netWeightG: toDecimal(decimalNumber(data.netWeight) ?? 0),
          source: data.source,
          totalPrice:
            data.source === 'purchase' && decimalNumber(data.price) !== null
              ? toDecimal(decimalNumber(data.price) ?? 0)
              : null,
          supplier: data.supplier.trim() || null,
        },
        keepIdentifierIds: spool.identifiers.filter((item) => data.keep[item.id]).map((item) => item.id),
        newIdentifiers: data.added
          .filter((item) => item.value.trim())
          .map((item) => ({ kind: item.kind, value: item.value.trim() })),
        occurredAt: new Date().toISOString(),
        expectedVersion: version,
      });
    },
  });
  const pending = mutation.isPending;

  const resetWizard = useLatestCallback(() => {
    reset(defaults(preselected));
    mutation.reset();
    setStep(preselected ? 1 : 0);
  });
  useEffect(() => {
    if (!open || !ready) return;
    resetWizard();
  }, [open, ready, preselected?.id, resetWizard]);

  const chooseSpool = (next: FilamentSpool | null) => {
    setValue('spoolId', next?.id ?? '', { shouldValidate: Boolean(next) });
    const fresh = defaults(next ?? undefined);
    for (const key of [
      'leftoverBasis',
      'grossWeight',
      'tareWeight',
      'leftoverOutcome',
      'productId',
      'manual',
      'materialId',
      'netWeight',
      'manufacturer',
      'product',
      'keep',
    ] as const)
      setValue(key, fresh[key]);
  };

  const chooseProduct = (product: FilamentProduct | null) => {
    setValue('productId', product?.id ?? '', { shouldValidate: Boolean(product) });
    if (!product) return;
    setValue('materialId', product.materialId, { shouldValidate: true });
    setValue('netWeight', decimalText(product.netWeightG));
    setValue('manufacturer', product.manufacturer);
    setValue('product', product.name);
    // The price only applies to a new purchase; it stays editable.
    setValue('price', product.defaultPrice != null ? decimalText(product.defaultPrice) : '');
  };
  const setManual = (next: boolean) => {
    setValue('manual', next);
    if (next) {
      setValue('productId', '');
      clearErrors('productId');
    }
  };

  const leftover = spool && !refillOnly ? resolveLeftover(spool, values) : null;
  const material = filaments.find((item) => item.id === values.materialId);
  const selectedProduct = products.find((item) => item.id === values.productId);
  const net = decimalNumber(values.netWeight) ?? 0;

  // Loose stock after the old fill has been closed: a returned leftover joins it, corrections and disposals leave the material.
  const stockAfterClose = (materialId: string) => {
    const target = filaments.find((item) => item.id === materialId);
    if (!target) return { total: 0, loose: 0 };
    const sameMaterial = Boolean(spool && !needsRefill(spool) && spool.materialId === materialId);
    const delta =
      spool && leftover && sameMaterial
        ? closeMaterialDelta({ remainingQuantity: remainingOf(spool), fillNumber: spool.fillNumber }, leftover.choice)
        : 0;
    const total = Math.round((toNumber(target.quantity) + delta) * 1000) / 1000;
    const others = toNumber(target.assignedQuantity) - (spool && sameMaterial ? remainingOf(spool) : 0);
    return { total, loose: Math.max(0, total - others) };
  };
  const stock = material ? stockAfterClose(material.id) : { total: 0, loose: 0 };

  const sourceHelper = !material
    ? 'Choose a material to see the effect on its stock.'
    : values.source === 'loose_stock'
      ? `Moves ${formatGrams(net)} from loose stock to this spool. The material total stays ${formatGrams(stock.total)}. ${formatGrams(stock.loose)} of loose stock is available.`
      : `Adds ${formatGrams(net)} to ${material.name} stock (new total ${formatGrams(stock.total + net)}) and records the purchase.`;

  const taken = (kind: string, value: string, index: number) => {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    if (
      choices.some(
        (item) =>
          item.id !== values.spoolId &&
          item.identifiers.some(
            (identifier) => identifierKey(identifier.kind, identifier.value) === identifierKey(kind, text),
          ),
      )
    )
      return 'This identifier is already assigned to another spool.';
    if (
      (spool?.identifiers ?? []).some(
        (identifier) =>
          values.keep[identifier.id] && identifierKey(identifier.kind, identifier.value) === identifierKey(kind, text),
      )
    )
      return 'This identifier is already kept on this spool.';
    if (
      getValues('added').some(
        (item, other) => other !== index && identifierKey(item.kind, item.value) === identifierKey(kind, text),
      )
    )
      return 'This identifier is entered twice.';
    return null;
  };

  const kept = (spool?.identifiers ?? []).filter((item) => values.keep[item.id]);
  const dropped = (spool?.identifiers ?? []).filter((item) => !values.keep[item.id]);
  const added = values.added.filter((item) => item.value.trim());
  const closing =
    spool && leftover
      ? planClose({ remainingQuantity: remainingOf(spool), fillNumber: spool.fillNumber }, leftover.choice)
      : [];
  const nextFill = (spool?.fillNumber ?? 0) + 1;
  const name = spool ? spoolNameText(spool) : 'spool';
  const review = [
    ...(spool && leftover
      ? [
          {
            key: 'close',
            change: `Close fill ${spool.fillNumber}`,
            detail: `${spool.materialName}: used ${formatGrams(Math.max(0, initialOf(spool) - leftover.choice.leftoverG))}, ${
              leftover.choice.leftoverG > 0
                ? `leftover ${formatGrams(leftover.choice.leftoverG)} ${leftover.choice.outcome === 'returned_to_stock' ? 'returned to loose stock' : 'disposed'}`
                : 'nothing left'
            }`,
          },
        ]
      : []),
    ...closing.map((entry, index) => ({
      key: `c${index}`,
      change: <TransactionKindTag kind={entry.kind} />,
      detail: `${entryText(entry.kind, entry.quantity, spool?.displayId ?? '')} · ${entry.note}`,
    })),
    {
      key: 'open',
      change: `Start fill ${nextFill}`,
      detail: material
        ? `${material.name}, ${formatGrams(net)}${[values.manufacturer, values.product].filter((item) => item.trim()).length ? `, ${[values.manufacturer, values.product].filter((item) => item.trim()).join(' ')}` : ''}`
        : 'No material chosen',
    },
    ...(material
      ? [
          {
            key: 'open-entry',
            change: <TransactionKindTag kind={values.source === 'purchase' ? 'purchase' : 'spool_transfer'} />,
            detail:
              values.source === 'purchase'
                ? `+${formatGrams(net)} bought${decimalNumber(values.price) !== null ? ` for ${(decimalNumber(values.price) ?? 0).toFixed(2)} €` : ''}, booked to ${name}`
                : `${entryText('spool_transfer', net, spool?.displayId ?? '')}, total unchanged`,
          },
        ]
      : []),
    {
      key: 'tags',
      change: 'Tags',
      detail: [
        `Keep ${kept.length === 0 ? 'none' : kept.map((item) => item.value).join(', ')}`,
        dropped.length ? `Remove ${dropped.map((item) => item.value).join(', ')}` : null,
        added.length
          ? `Add ${added.map((item) => `${identifierLabel(item.kind)} ${item.value.trim()}`).join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];

  const next = async () => {
    if (!(await trigger(STEP_FIELDS[current]))) return;
    setStep((value) => value + 1);
  };

  const submit = handleSubmit(async (data) => {
    if (!spool || !material) return;
    let result: FilamentSpool;
    try {
      result = await mutation.mutateAsync(data);
    } catch {
      await refresh();
      return;
    }
    await refresh();
    notify({ kind: 'success', title: `${spool.displayId} refilled with ${material.name} (fill ${result.fillNumber})` });
    onClose();
  });

  return {
    narrow,
    step,
    setStep,
    canPurchase,
    spoolList,
    materialList,
    productList,
    ready,
    loadFailed,
    choices,
    filaments,
    products,
    form,
    fields,
    append,
    remove,
    values,
    spool,
    refillOnly,
    steps,
    current,
    last,
    mutation,
    pending,
    chooseSpool,
    chooseProduct,
    setManual,
    leftover,
    material,
    selectedProduct,
    net,
    stockAfterClose,
    stock,
    sourceHelper,
    taken,
    added,
    nextFill,
    name,
    review,
    next,
    submit,
    errors,
    control,
    register,
  };
}

export type ChangeFilamentWizard = ReturnType<typeof useChangeFilamentWizard>;
