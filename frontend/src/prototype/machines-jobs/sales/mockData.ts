import * as base from '../mockData';
import { ago } from '../mockData';
import type { BillingParty, Job, JobOutcome, Operator, PriceAdjustment } from '../types';
import {
  addJobItems, addManualItem, cancelDraft, cancelRequest, commitReplacement, createDraft, finalizeOrder, forwardRequestToWiRef, prepareInvoiceRequest, recordCashMovement, recordPayments,
  recordRequestReference, requestCancellation, returnRequestForCorrection, submitRequestForApproval, reverseOrder, reversePayment, startReplacement, updateManualItem, updateRequestDetails, type CashMovementInput, type Ctx, type SalesState,
} from './engine';
import { dateInAppTimeZone } from './format';
import { activeItems, sum } from './logic';
import { defaultPricingConfig, quoteJob, resolveGroup } from './pricing';
import type { BillingContact, InvoiceRequestDetails, OrganizationRecord, PaymentInput, PaymentMethod } from './types';

// The sales seed is not a hand-written pile of rows: it replays real actions through the engine at past times, so every
// reference, allocation, timeline and job claim obeys the same rules as live use. ~30 orders in every state, every one with a customer.

const H = 60;
const D = 24 * H;
const [lena, jonas, amira, tobias, racing, robotics, mara, felix, elif, kreativ, htl, fablab] = base.people;
const [sara, david, nina] = base.operators;
const FRONT_DESK = 'Sara Kofler';

const material = (id: string) => base.materials.find((item) => item.id === id)!;

type JobSpec = {
  num: number; title: string | null; machineId: string; customer: BillingParty; endedAgo: number; minutes: number; usages: [materialId: string, quantity: number][];
  operator?: Operator; outcome?: JobOutcome; adjustment?: PriceAdjustment; version?: number; group?: string; notes?: string;
};

/** Organizations are the only customers that are not accounts. Billing data is what the invoice request form prefills. */
const org = (id: string, name: string, kind: OrganizationRecord['kind'], pricingGroup: string | null, requiresPurchaseOrder: boolean, billing: BillingContact, active = true): OrganizationRecord => ({ id, name, kind, pricingGroup, requiresPurchaseOrder, active, billing });
const seedOrganizations: OrganizationRecord[] = [
  org('o-racing', 'TU Graz Racing Team', 'association', 'Student teams', false, { addressLine1: 'Inffeldgasse 11', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: 'Julia Prem' }),
  org('o-robotics', 'Robotics Lab', 'institute', 'Institutes', true, { addressLine1: 'Inffeldgasse 13', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: 'Dr. Markus Reiter' }),
  org('o-kreativ', 'Kreativwerkstatt Graz GmbH', 'company', null, true, { addressLine1: 'Schmiedgasse 8', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: 'Petra Lang' }),
  org('o-htl', 'HTL Bulme Robotics Club', 'association', 'Student teams', false, { addressLine1: 'Pestalozzistraße 3', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: 'Dr. Weber' }),
  org('o-fablab', 'FabLab Steiermark Verein', 'association', 'Institutes', false, { addressLine1: 'Reininghausstraße 13', postalCode: '8020', locality: 'Graz', countryCode: 'AT', contactName: 'Tim Auer' }),
  org('o-leoben', 'Leoben Maker Collective', 'association', null, false, { addressLine1: 'Franz-Josef-Straße 18', postalCode: '8700', locality: 'Leoben', countryCode: 'AT', contactName: '' }, false),
];
/** Where accounts live, for the invoice request prefill. Not every account has an address on file. */
export const accountBilling: Record<string, BillingContact> = {
  'p-lena': { addressLine1: 'Heinrichstraße 5', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: '' },
  'p-amira': { addressLine1: 'Jakominiplatz 3', postalCode: '8010', locality: 'Graz', countryCode: 'AT', contactName: '' },
  'p-tobias': { addressLine1: 'Lendkai 12', postalCode: '8020', locality: 'Graz', countryCode: 'AT', contactName: '' },
};

const seedPricing = defaultPricingConfig();

function makeJob(spec: JobSpec): Job {
  const resolved = resolveGroup(seedPricing, seedOrganizations, spec.customer, spec.group);
  const group = resolved.group.name;
  const usages = spec.usages.map(([materialId, quantity], index) => {
    const item = material(materialId);
    return { id: `u-${spec.num}-${index}`, ownership: 'makerspace' as const, materialId, spoolId: null, spoolDisplayId: null, materialName: item.name, category: item.category, unit: item.unit, quantity, quantityBasis: 'actual' as const };
  });
  const quote = quoteJob({ group, durationSeconds: spec.minutes * 60, usages });
  return {
    id: `j-${spec.num}`, displayId: `J-${spec.num}`, title: spec.title, machineId: spec.machineId, startsAt: ago(spec.endedAgo + spec.minutes), endsAt: ago(spec.endedAgo), durationSeconds: spec.minutes * 60,
    run: 'manual', printId: null, source: 'manual', externalId: null, customer: spec.customer, operator: spec.operator ?? [sara, david, nina][spec.num % 3], outcome: spec.outcome ?? 'successful', notes: spec.notes ?? null,
    usages, pricingStatus: 'complete', pricingSnapshot: { revision: 1, pricingGroupName: group, via: resolved.reason, reason: 'initial', capturedAt: ago(spec.endedAgo), rules: quote.rules },
    calculatedPrice: quote.total, priceAdjustment: spec.adjustment ?? null, pricingGroupOverride: spec.group ?? null, order: null, version: spec.version ?? 1,
  };
}

const PLA = 'mat-pla-black'; const PETG = 'mat-petg-white'; const ASA = 'mat-asa-grey'; const PLY = 'mat-ply-3'; const MDF = 'mat-mdf-6';

// Jobs of the identified orders and the ready-to-bill list (J-1065 to J-1082).
const extraJobs: Job[] = [
  makeJob({ num: 1082, title: 'Laser-cut shelf brackets', machineId: 'm-laser', customer: amira, endedAgo: 8 * D + 3 * H, minutes: 45, usages: [[PLY, 0.6]] }),
  makeJob({ num: 1081, title: 'Sensor housing batch', machineId: 'm-mk4-1', customer: amira, endedAgo: 8 * D + 3 * H, minutes: 240, usages: [[PETG, 180]] }),
  makeJob({ num: 1080, title: 'Spare gears', machineId: 'm-mk4-2', customer: elif, endedAgo: 6 * D + 4 * H, minutes: 120, usages: [[PLA, 90]] }),
  makeJob({ num: 1079, title: 'Hinge prototypes', machineId: 'm-x1c', customer: felix, endedAgo: 5 * D + 6 * H, minutes: 150, usages: [[ASA, 70]] }),
  makeJob({ num: 1078, title: 'Cable guides', machineId: 'm-mk4-1', customer: tobias, endedAgo: 3 * D + 2 * H, minutes: 90, usages: [[PETG, 55]], version: 2 }),
  makeJob({ num: 1077, title: 'Display stands', machineId: 'm-laser', customer: kreativ, endedAgo: 9 * D + 6 * H, minutes: 70, usages: [[PLY, 1.4]] }),
  makeJob({ num: 1076, title: 'Sign blanks', machineId: 'm-cnc', customer: kreativ, endedAgo: 9 * D + 5 * H, minutes: 100, usages: [[MDF, 0.8]] }),
  makeJob({ num: 1075, title: 'Gripper fingers', machineId: 'm-x1c', customer: robotics, endedAgo: 4 * D + 5 * H, minutes: 130, usages: [[ASA, 85]] }),
  makeJob({ num: 1074, title: 'Camera mounts', machineId: 'm-mk4-2', customer: robotics, endedAgo: 4 * D + 4 * H, minutes: 95, usages: [[PETG, 60]] }),
  makeJob({ num: 1073, title: 'Exhibition models', machineId: 'm-h2d', customer: kreativ, endedAgo: 6 * D + 8 * H, minutes: 300, usages: [[PLA, 240]] }),
  makeJob({ num: 1072, title: 'Chassis plates', machineId: 'm-laser', customer: htl, endedAgo: 7 * D + 2 * H, minutes: 85, usages: [[PLY, 2.0]] }),
  makeJob({ num: 1071, title: 'Prototype enclosures', machineId: 'm-x1c', customer: fablab, endedAgo: 11 * D, minutes: 200, usages: [[ASA, 150]] }),
  makeJob({ num: 1070, title: 'Cosplay armour parts', machineId: 'm-h2d', customer: mara, endedAgo: 3 * D + 5 * H, minutes: 260, usages: [[PLA, 190]] }),
  makeJob({ num: 1069, title: 'Replacement knobs', machineId: 'm-mk4-2', customer: tobias, endedAgo: 20 * H, minutes: 50, usages: [[PETG, 30]] }),
  makeJob({ num: 1068, title: 'Poster frame corners', machineId: 'm-mk4-1', customer: lena, endedAgo: 15 * H, minutes: 70, usages: [[PLA, 45]] }),
  makeJob({ num: 1067, title: 'Shop sign letters', machineId: 'm-cnc', customer: kreativ, endedAgo: 2 * D + 3 * H, minutes: 120, usages: [[MDF, 0.9]] }),
  makeJob({ num: 1066, title: 'Phone stand', machineId: 'm-mk4-2', customer: mara, endedAgo: 5 * H, minutes: 55, usages: [[PLA, 35]] }),
  makeJob({ num: 1064, title: 'Drawer dividers', machineId: 'm-laser', customer: lena, endedAgo: 30 * H, minutes: 35, usages: [[PLY, 0.5]] }),
  makeJob({ num: 1063, title: 'Spare clips', machineId: 'm-mk4-1', customer: tobias, endedAgo: 12 * H, minutes: 40, usages: [[PETG, 25]] }),
  makeJob({ num: 1062, title: 'Sample plates', machineId: 'm-cnc', customer: kreativ, endedAgo: 2 * D + 20 * H, minutes: 55, usages: [[MDF, 0.4]] }),
  makeJob({ num: 1065, title: 'Camera lens cap', machineId: 'm-x1c', customer: felix, endedAgo: 9 * H, minutes: 40, usages: [[ASA, 22]], adjustment: { kind: 'discount_percent', value: 10, reason: 'First order of a new customer.' } }),
];

export function buildSalesSeed() {
  let state: SalesState = {
    orders: [], payments: [], allocations: [], adjustments: [], requests: [], jobs: [...structuredClone(extraJobs), ...structuredClone(base.jobs)],
    counters: { order: 100, payment: 300, adjustment: 8, request: 40, movement: 12 },
    // Two organizations require a purchase order reference on their invoices.
    organizations: structuredClone(seedOrganizations), cashMovements: [], pricing: structuredClone(seedPricing),
  };
  const ctx = (minutesAgo: number, actor = FRONT_DESK): Ctx => ({ at: ago(minutesAgo), actor, canApproveInvoices: true, machines: base.machines, machineTypes: base.machineTypes, prints: base.prints });
  let tx = 48300;
  const pay = (minutesAgo: number, method: PaymentMethod, amount: number): PaymentInput => ({
    method, amount, occurredAt: ago(minutesAgo), terminal: method === 'card' ? 'Terminal 1' : method === 'external' ? 'wiRef' : '', transactionReference: method === 'card' ? `T-${++tx}` : method === 'external' ? `WR-${++tx}` : '',
  });
  const customerOf = (party: BillingParty) => ({ customer: party, fulfillmentMode: 'immediate' as const });
  const draft = (m: number, party: BillingParty, actor?: string, fulfillmentMode: 'immediate' | 'deferred' = 'immediate') => { const r = createDraft(state, ctx(m, actor), { ...customerOf(party), fulfillmentMode }); state = r.state; return r.orderId; };
  const totalOf = (orderId: string) => sum(activeItems(state.orders.find((order) => order.id === orderId)!).map((item) => item.amount));
  const jobs = (m: number, orderId: string, ...ids: string[]) => { state = addJobItems(state, ctx(m), orderId, ids).state; };
  const manual = (m: number, orderId: string, description: string, quantity: number, unit: string, unitPrice: number) => { state = addManualItem(state, ctx(m), orderId, { description, quantity, unit, unitPrice }).state; };
  const finalize = (m: number, orderId: string) => { state = finalizeOrder(state, ctx(m), orderId).state; };
  const record = (m: number, orderId: string, ...inputs: PaymentInput[]) => { state = recordPayments(state, ctx(m), orderId, inputs).state; };

  // Orders that were handed over and paid on the spot (formerly counter sales): each one has a customer, an account or an organization --------------
  const sale = (n: number, m: number, party: BillingParty, machineId: string, minutes: number, usages: [string, number][], opts: { adjustment?: PriceAdjustment; extras?: [string, number, string, number][]; pays?: [PaymentMethod, number | 'rest'][]; operator?: Operator } = {}) => {
    const job = makeJob({ num: 1040 + n, title: null, machineId, customer: party, endedAgo: m, minutes, usages, operator: opts.operator ?? [sara, david, nina][n % 3], adjustment: opts.adjustment });
    state.jobs.unshift(job);
    const id = draft(m - 1, party, job.operator!.displayName); jobs(m - 2, id, job.id);
    (opts.extras ?? []).forEach(([description, quantity, unit, unitPrice]) => manual(m - 2, id, description, quantity, unit, unitPrice));
    finalize(m - 3, id);
    let left = totalOf(id);
    (opts.pays ?? []).forEach(([method, amount], index) => {
      const value = amount === 'rest' ? left : amount;
      left = Math.round((left - value) * 100) / 100;
      record(m - 4 - index, id, pay(m - 4 - index, method, value));
    });
  };
  sale(1, 9 * D + 4 * H, jonas, 'm-laser', 20, [[PLY, 0.3]], { pays: [['cash', 'rest']] });
  sale(2, 7 * D + 2 * H, tobias, 'm-mk4-1', 90, [[PLA, 60]], { pays: [['card', 'rest']] });
  sale(3, 5 * D + 6 * H, felix, 'm-mk4-2', 45, [[PETG, 30]], { pays: [['cash', 4], ['card', 'rest']] });
  sale(4, 4 * D + 1 * H, elif, 'm-x1c', 180, [[ASA, 120]], { extras: [['Bed adhesive stick', 1, 'piece', 5.5]], pays: [['card', 'rest']] });
  sale(5, 3 * D + 4 * H, htl, 'm-cnc', 60, [[MDF, 0.25]], { adjustment: { kind: 'fixed', value: 0, reason: 'Demonstration for a school visit.' } });
  sale(6, 2 * D + 2 * H, mara, 'm-laser', 30, [[PLY, 0.5]], { extras: [['Plywood offcut, A4 size', 1, 'piece', 1.5]], pays: [['cash', 5], ['card', 'rest']] });
  sale(7, 1 * D + 5 * H, lena, 'm-mk4-1', 120, [[PLA, 100]], { adjustment: { kind: 'discount_percent', value: 10, reason: 'Regular visitor.' }, pays: [['cash', 'rest']] });
  sale(8, 2 * H + 10, amira, 'm-h2d', 240, [[PETG, 150]], { pays: [['card', 'rest']] });
  sale(9, 55, jonas, 'm-mk4-2', 30, [[PLA, 25]], { pays: [['cash', 'rest']] });
  sale(10, 12, tobias, 'm-laser', 15, [[PLY, 0.2]], { extras: [['Screw assortment M3', 1, 'pack', 3]], pays: [['cash', 3], ['card', 'rest']] });

  // Identified orders on the existing jobs -------------------------------------------------------------------------------
  const lenaOpen = draft(1300, lena, undefined, 'deferred'); jobs(1295, lenaOpen, 'j-1089'); finalize(1290, lenaOpen);

  const split = draft(2700, tobias); jobs(2695, split, 'j-1087'); finalize(2690, split); record(2600, split, pay(2600, 'cash', 5), pay(2590, 'card', 4));

  const racingOrder = draft(6900, racing); jobs(6895, racingOrder, 'j-1084'); finalize(6890, racingOrder);
  record(6800, racingOrder, pay(6800, 'cash', 5)); record(4400, racingOrder, pay(4400, 'card', 5));
  // The job was corrected after it was charged: the item keeps the version it captured.
  state.orders.find((order) => order.id === racingOrder)!.items[0].sourceJobVersion = 4;

  const lenaPaid = draft(8500, lena); jobs(8495, lenaPaid, 'j-1083'); finalize(8490, lenaPaid); record(8480, lenaPaid, pay(8480, 'card', 4.8));

  // Drafts in different shapes
  const lenaDraft = draft(4300, lena, 'David Mayr'); manual(4290, lenaDraft, 'Laser engraving, name plate', 1, 'piece', 6.5); manual(4285, lenaDraft, 'Birch plywood offcut', 2, 'piece', 1.5);
  const staleDraft = draft(3 * D + 1 * H, tobias); jobs(3 * D + 1 * H - 5, staleDraft, 'j-1078');
  state.orders.find((order) => order.id === staleDraft)!.items[0].sourceJobVersion = 1;
  const oldDraft = draft(12 * D, jonas, 'Nina Berger'); manual(12 * D - 5, oldDraft, 'PLA spool 1 kg, black', 1, 'piece', 19.9); manual(12 * D - 8, oldDraft, 'Nozzle 0.4 mm, hardened', 1, 'piece', 12);
  const kreativDraft = draft(9 * D + 4 * H, kreativ); jobs(9 * D + 4 * H - 3, kreativDraft, 'j-1077', 'j-1076');
  const cancelled = draft(6 * D, mara); manual(6 * D - 3, cancelled, 'Test print', 1, 'piece', 5);
  state = cancelDraft(state, ctx(6 * D - 60), cancelled).state;

  // Replacement: order A (8 d) is corrected into order B (2 d); the cash payment moves over.
  const a = draft(8 * D + 2 * H, amira); jobs(8 * D + 2 * H - 5, a, 'j-1081'); manual(8 * D + 2 * H - 8, a, 'Finishing and assembly', 1, 'hour', 20);
  finalize(8 * D + 2 * H - 10, a); record(7 * D + 20 * H, a, pay(7 * D + 20 * H, 'cash', 20));
  const startedReplacement = startReplacement(state, ctx(2 * D + 3 * H), a); state = startedReplacement.state;
  const b = startedReplacement.orderId;
  const finishing = state.orders.find((order) => order.id === b)!.items.find((item) => item.kind === 'manual')!;
  state = updateManualItem(state, ctx(2 * D + 2 * H + 50), b, finishing.id, { description: 'Finishing and assembly', quantity: 0.5, unit: 'hour', unitPrice: 20 }).state;
  state = commitReplacement(state, ctx(2 * D + 2 * H), a, b, { reason: 'Finishing took half an hour, not a full one.', reversals: [], payments: [] }).state;

  // Whole order cancelled and the card payment refunded
  const refunded = draft(6 * D + 3 * H, elif); jobs(6 * D + 3 * H - 5, refunded, 'j-1080'); finalize(6 * D + 3 * H - 8, refunded);
  record(6 * D + 2 * H, refunded, pay(6 * D + 2 * H, 'card', totalOf(refunded)));
  state = reverseOrder(state, ctx(4 * D), refunded, {
    reason: 'The customer cancelled the project.',
    reversals: [{ paymentId: state.payments.at(-1)!.id, reasonKind: 'refund', reason: 'Card refund at the terminal.', occurredAt: ago(4 * D), transactionReference: 'RF-90112' }],
  }).state;

  // Recording error: cash was entered but the customer paid by card; corrected with a replacement receipt
  const felixOrder = draft(5 * D + 5 * H, felix); jobs(5 * D + 5 * H - 5, felixOrder, 'j-1079'); finalize(5 * D + 5 * H - 8, felixOrder);
  const felixTotal = totalOf(felixOrder);
  record(5 * D + 4 * H, felixOrder, pay(5 * D + 4 * H, 'cash', felixTotal));
  state = reversePayment(state, ctx(5 * D + 3 * H + 30), { paymentId: state.payments.at(-1)!.id, reasonKind: 'recording_error', reason: 'Paid by card, cash was selected by mistake.', occurredAt: ago(5 * D + 3 * H + 30), transactionReference: '' }, pay(5 * D + 4 * H, 'card', felixTotal)).state;

  // Installments
  const installments = draft(3 * D + 4 * H, mara); jobs(3 * D + 4 * H - 5, installments, 'j-1070'); finalize(3 * D + 4 * H - 8, installments);
  const first = Math.round(totalOf(installments) * 0.4 * 100) / 100; const second = Math.round(totalOf(installments) * 0.35 * 100) / 100;
  record(3 * D + 3 * H, installments, pay(3 * D + 3 * H, 'cash', first)); record(2 * D, installments, pay(2 * D, 'cash', second));
  record(1 * D + 2 * H, installments, pay(1 * D + 2 * H, 'cash', Math.round((totalOf(installments) - first - second) * 100) / 100));

  // Smaller paid orders without jobs
  const small = (m: number, party: BillingParty, description: string, quantity: number, unit: string, unitPrice: number, ...pays: [PaymentMethod, number][]) => {
    const id = draft(m, party, 'David Mayr'); manual(m - 3, id, description, quantity, unit, unitPrice); finalize(m - 5, id);
    pays.forEach(([method, amount], index) => record(m - 10 - index, id, pay(m - 10 - index, method, amount)));
  };
  small(4 * D + 7 * H, jonas, 'Course material: filament sample set', 1, 'set', 12.5, ['cash', 12.5]);
  small(2 * D + 6 * H, amira, 'Laser cutting service, hourly', 1.5, 'hour', 14, ['card', 12], ['cash', 9]);
  small(26 * H, lena, '3D scan of an object', 1, 'piece', 15, ['cash', 15]);
  small(6 * D + 9 * H, elif, 'Machine introduction course', 1, 'person', 25, ['card', 15], ['cash', 10]);
  small(3 * D + 9 * H, felix, 'Rush job surcharge', 1, 'piece', 18, ['card', 10], ['card', 8]);
  small(2 * D + 10 * H, mara, 'Laser engraving, 12 phone cases', 12, 'piece', 1.75, ['cash', 11], ['cash', 10]);
  small(30 * H, tobias, 'Heat-set inserts, 40 pieces', 2, 'pack', 4.5, ['cash', 4.5], ['card', 4.5]);

  // wiRef-backed orders: every step is replayed through the engine at its own past time -------------------------------------------
  const NINA = 'Nina Berger';
  const wiRefOrder = (party: BillingParty, m: number, ids: string[], items: [string, number, string, number][] = []) => {
    const id = draft(m, party, NINA); if (ids.length) jobs(m - 4, id, ...ids); items.forEach(([description, quantity, unit, unitPrice]) => manual(m - 4, id, description, quantity, unit, unitPrice)); finalize(m - 6, id);
    const r = prepareInvoiceRequest(state, ctx(m - 60, NINA), id); state = r.state; return { id, requestId: r.requestId };
  };
  const requestOf = (id: string) => state.requests.find((request) => request.id === id)!;
  const details = (m: number, requestId: string, patch: Partial<InvoiceRequestDetails>) => { state = updateRequestDetails(state, ctx(m, NINA), requestId, { ...requestOf(requestId).details, ...patch }).state; };
  // Staff submit for approval; management (Marlene Huber) forwards the data to wiRef and may add the invoice number later.
  const MANAGER = 'Marlene Huber';
  const submit = (m: number, requestId: string) => { state = submitRequestForApproval(state, ctx(m, NINA), requestId).state; };
  const returnIt = (m: number, requestId: string, comment: string) => { state = returnRequestForCorrection(state, ctx(m, MANAGER), requestId, comment).state; };
  const forward = (m: number, requestId: string) => { state = forwardRequestToWiRef(state, ctx(m, MANAGER), requestId).state; };
  const addNumber = (m: number, requestId: string, externalReference: string) => {
    state = recordRequestReference(state, ctx(m, NINA), requestId, { externalReference, reason: '', effectiveOn: dateInAppTimeZone(ago(m)) }).state;
  };
  const issue = (m: number, requestId: string, externalReference: string) => { forward(m + 30, requestId); addNumber(m, requestId, externalReference); };

  // Still a draft: the address is in, but the contact person and the purchase order reference the organization requires are missing.
  const wiRefDraft = wiRefOrder(robotics, 4 * D + 2 * H, ['j-1075', 'j-1074']);
  details(4 * D + 90, wiRefDraft.requestId, { addressLine1: 'Inffeldgasse 13', postalCode: '8010', locality: 'Graz' });

  // Awaiting approval: complete, waiting for management to approve and forward it to wiRef.
  const readyOrder = wiRefOrder(racing, 2 * D + 7 * H, [], [['Large-format banner cutting, 6 pieces', 6, 'piece', 20]]);
  details(2 * D + 6 * H, readyOrder.requestId, { addressLine1: 'Inffeldgasse 11', postalCode: '8010', locality: 'Graz', contactName: 'Julia Prem' });
  submit(2 * D + 5 * H + 30, readyOrder.requestId);

  const submitted = wiRefOrder(kreativ, 6 * D + 5 * H, ['j-1073']);
  details(6 * D + 4 * H, submitted.requestId, { addressLine1: 'Schmiedgasse 8', postalCode: '8010', locality: 'Graz', contactName: 'Petra Lang', purchaseOrderReference: 'PO-2026-0412' });
  // Forwarded to wiRef, the invoice number is not recorded yet.
  submit(6 * D + 3 * H, submitted.requestId); forward(6 * D + 2 * H, submitted.requestId);

  const issued = wiRefOrder(htl, 7 * D, ['j-1072']);
  details(7 * D - 60, issued.requestId, { addressLine1: 'Pestalozzistraße 3', postalCode: '8010', locality: 'Graz', contactName: 'Dr. Weber' });
  submit(6 * D + 20 * H, issued.requestId); issue(5 * D + 6 * H, issued.requestId, 'RE-2026-0187');

  // Cancellation requested: wiRef issued the invoice, then the amount turned out to be wrong.
  const unwinding = wiRefOrder(htl, 5 * D + 3 * H, [], [['Workshop day for 12 pupils', 12, 'person', 15]]);
  details(5 * D + 2 * H, unwinding.requestId, { addressLine1: 'Pestalozzistraße 3', postalCode: '8010', locality: 'Graz', contactName: 'Dr. Weber', serviceDescription: 'Workshop day with 12 pupils' });
  submit(5 * D + 1 * H, unwinding.requestId); issue(4 * D + 20 * H, unwinding.requestId, 'RE-2026-0191');
  state = requestCancellation(state, ctx(3 * D + 4 * H, NINA), unwinding.requestId, 'Eleven pupils took part, not twelve. A corrected invoice is needed.').state;

  // Cancelled before it was forwarded, and prepared again: the new request links back to the old one.
  const redo = wiRefOrder(fablab, 3 * D + 2 * H, [], [['Reprint of prototype enclosures', 1, 'set', 80]]);
  details(3 * D + 60, redo.requestId, { addressLine1: 'Reininghausstraße 13', postalCode: '8020', locality: 'Graz', contactName: 'Tim Auer', serviceDescription: 'Prototype enclosures' });
  submit(3 * D + 30, redo.requestId);
  state = cancelRequest(state, ctx(3 * D, NINA), redo.requestId, 'The recipient asked for a different billing address.').state;
  const again = prepareInvoiceRequest(state, ctx(2 * D + 20 * H, NINA), redo.id); state = again.state;
  details(2 * D + 19 * H, again.requestId, { addressLine1: 'Lendkai 45', postalCode: '8020', locality: 'Graz', contactName: 'Tim Auer', serviceDescription: 'Prototype enclosures' });
  // Submitted, then returned by management: the draft shows the comment until it is submitted again.
  submit(2 * D + 18 * H, again.requestId); returnIt(2 * D + 17 * H, again.requestId, 'Please bill the faculty office, not the lab, and add the service period of the print run.');

  const cancelledRequest = wiRefOrder(fablab, 11 * D, ['j-1071']);
  state = cancelRequest(state, ctx(9 * D, NINA), cancelledRequest.requestId, 'The recipient asked for a different billing address.').state;
  state = reverseOrder(state, ctx(8 * D + 2 * H, NINA), cancelledRequest.id, { reason: 'Wrong billing details; to be charged again with the new address.', reversals: [] }).state;

  // Invoices for orders that were already paid [proposed rule]: the request carries what was paid, the invoice settles the rest when it is issued.
  const paidFirst = draft(3 * D, kreativ, NINA); manual(3 * D - 3, paidFirst, 'Laser engraving, 20 coasters', 20, 'piece', 2.5); finalize(3 * D - 5, paidFirst);
  record(3 * D - 8, paidFirst, pay(3 * D - 8, 'card', totalOf(paidFirst)));
  const paidFirstRequest = prepareInvoiceRequest(state, ctx(2 * D + 22 * H, NINA), paidFirst); state = paidFirstRequest.state;
  details(2 * D + 21 * H, paidFirstRequest.requestId, { addressLine1: 'Schmiedgasse 8', postalCode: '8010', locality: 'Graz', contactName: 'Petra Lang', purchaseOrderReference: 'PO-2026-0455', serviceDescription: 'Laser engraving, 20 coasters (paid by card at the desk)' });
  submit(2 * D + 20 * H, paidFirstRequest.requestId); issue(2 * D + 4 * H, paidFirstRequest.requestId, 'RE-2026-0203');

  const mixed = draft(2 * D + 9 * H, htl, NINA); manual(2 * D + 9 * H - 3, mixed, 'Robotics workshop for 8 pupils', 8, 'person', 15); finalize(2 * D + 9 * H - 5, mixed);
  record(2 * D + 9 * H - 8, mixed, pay(2 * D + 9 * H - 8, 'cash', 40));
  const mixedRequest = prepareInvoiceRequest(state, ctx(2 * D + 8 * H, NINA), mixed); state = mixedRequest.state;
  details(2 * D + 7 * H, mixedRequest.requestId, { addressLine1: 'Pestalozzistraße 3', postalCode: '8010', locality: 'Graz', contactName: 'Dr. Weber', serviceDescription: 'Robotics workshop for 8 pupils (40 euro paid in cash)' });
  submit(2 * D + 6 * H, mixedRequest.requestId); issue(1 * D + 20 * H, mixedRequest.requestId, 'RE-2026-0207');

  // Cash movements [proposed]: a float to start with, bank deposits and the safe.
  const movement = (m: number, input: Omit<CashMovementInput, 'occurredAt'>, actor = FRONT_DESK) => { state = recordCashMovement(state, ctx(m, actor), { ...input, occurredAt: ago(m) }).state; };
  movement(10 * D, { kind: 'deposit', amount: 100, reason: 'float', note: 'Starting float for the cash register.' });
  movement(4 * D + 2 * H, { kind: 'withdrawal', amount: 60, reason: 'bank_deposit', note: '' });
  movement(2 * D + 30, { kind: 'withdrawal', amount: 8.5, reason: 'other', note: 'Coffee beans for the team kitchen.' }, 'David Mayr');
  movement(1 * D + 3 * H, { kind: 'withdrawal', amount: 25, reason: 'safe', note: '' });
  movement(5 * H, { kind: 'deposit', amount: 20, reason: 'float', note: 'Coins for change.' });

  return state;
}

export const salesSeed = buildSalesSeed();
