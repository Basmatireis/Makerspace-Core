import * as base from '../mockData';
import { ago } from '../mockData';
import type { BillingParty, Job, JobOutcome, Operator, PriceAdjustment } from '../types';
import {
  addJobItems, addManualItem, cancelDraft, commitReplacement, counterSale, createDraft, finalizeOrder, prepareInvoiceRequest, recordPayments, reverseOrder, reversePayment,
  startReplacement, updateManualItem, type Ctx, type SalesState,
} from './engine';
import { activeItems, sum } from './logic';
import { defaultPricingGroup, quoteJob } from './pricing';
import type { PaymentInput, PaymentMethod } from './types';

// The sales seed is not a hand-written pile of rows: it replays real actions through the engine at past times, so every
// reference, allocation, timeline and job claim obeys the same rules as live use. ~30 orders in every state.

const H = 60;
const D = 24 * H;
const [lena, jonas, amira, tobias, racing, robotics, mara, felix, elif, kreativ, htl, fablab] = base.people;
const [sara, david, nina] = base.operators;
const FRONT_DESK = 'Sara Kofler';

const material = (id: string) => base.materials.find((item) => item.id === id)!;

type JobSpec = {
  num: number; title: string | null; machineId: string; customer: BillingParty | null; endedAgo: number; minutes: number; usages: [materialId: string, quantity: number][];
  operator?: Operator; outcome?: JobOutcome; adjustment?: PriceAdjustment; version?: number; group?: string; notes?: string;
};

function makeJob(spec: JobSpec): Job {
  const group = spec.group ?? spec.customer?.pricingGroup ?? defaultPricingGroup;
  const usages = spec.usages.map(([materialId, quantity], index) => {
    const item = material(materialId);
    return { id: `u-${spec.num}-${index}`, ownership: 'makerspace' as const, materialId, spoolId: null, spoolDisplayId: null, materialName: item.name, category: item.category, unit: item.unit, quantity, quantityBasis: 'actual' as const };
  });
  const quote = quoteJob({ group, durationSeconds: spec.minutes * 60, usages });
  return {
    id: `j-${spec.num}`, displayId: `J-${spec.num}`, title: spec.title, machineId: spec.machineId, startsAt: ago(spec.endedAgo + spec.minutes), endsAt: ago(spec.endedAgo), durationSeconds: spec.minutes * 60,
    run: 'manual', printId: null, source: 'manual', externalId: null, customer: spec.customer, operator: spec.operator ?? [sara, david, nina][spec.num % 3], outcome: spec.outcome ?? 'successful', notes: spec.notes ?? null,
    usages, pricingStatus: 'complete', pricingSnapshot: { revision: 1, pricingGroupName: group, reason: 'initial', capturedAt: ago(spec.endedAgo), rules: quote.rules },
    calculatedPrice: quote.total, priceAdjustment: spec.adjustment ?? null, order: null, version: spec.version ?? 1,
  };
}

const PLA = 'mat-pla-black'; const PETG = 'mat-petg-white'; const ASA = 'mat-asa-grey'; const PLY = 'mat-ply-3'; const MDF = 'mat-mdf-6';

// Jobs of the identified orders and the ready-to-bill list (J-1065 to J-1082).
const extraJobs: Job[] = [
  makeJob({ num: 1082, title: 'Laser-cut shelf brackets', machineId: 'm-laser', customer: amira, endedAgo: 8 * D + 3 * H, minutes: 45, usages: [[PLY, 0.6]] }),
  makeJob({ num: 1081, title: 'Sensor housing batch', machineId: 'm-mk4-1', customer: amira, endedAgo: 8 * D + 3 * H, minutes: 240, usages: [[PETG, 180]], group: 'Staff' }),
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
    counters: { order: 100, payment: 300, adjustment: 8, request: 40 },
  };
  const ctx = (minutesAgo: number, actor = FRONT_DESK): Ctx => ({ at: ago(minutesAgo), actor, machines: base.machines, machineTypes: base.machineTypes, prints: base.prints });
  let tx = 48300;
  const pay = (minutesAgo: number, method: PaymentMethod, amount: number): PaymentInput => ({
    method, amount, occurredAt: ago(minutesAgo), terminal: method === 'card' ? 'Terminal 1' : method === 'external' ? 'wiRef' : '', transactionReference: method === 'card' ? `T-${++tx}` : method === 'external' ? `WR-${++tx}` : '',
  });
  const customerOf = (party: BillingParty | null) => ({ customer: party, fulfillmentMode: 'immediate' as const });
  const draft = (m: number, party: BillingParty | null, actor?: string, fulfillmentMode: 'immediate' | 'deferred' = 'immediate') => { const r = createDraft(state, ctx(m, actor), { ...customerOf(party), fulfillmentMode }); state = r.state; return r.orderId; };
  const totalOf = (orderId: string) => sum(activeItems(state.orders.find((order) => order.id === orderId)!).map((item) => item.amount));
  const jobs = (m: number, orderId: string, ...ids: string[]) => { state = addJobItems(state, ctx(m), orderId, ids).state; };
  const manual = (m: number, orderId: string, description: string, quantity: number, unit: string, unitPrice: number) => { state = addManualItem(state, ctx(m), orderId, { description, quantity, unit, unitPrice }).state; };
  const finalize = (m: number, orderId: string) => { state = finalizeOrder(state, ctx(m), orderId).state; };
  const record = (m: number, orderId: string, ...inputs: PaymentInput[]) => { state = recordPayments(state, ctx(m), orderId, inputs).state; };

  // Counter sales (walk-in customers, paid on the spot) -------------------------------------------------------------------
  const sale = (n: number, m: number, machineId: string, minutes: number, usages: [string, number][], opts: { adjustment?: PriceAdjustment; extras?: [string, number, string, number][]; pays?: [PaymentMethod, number][]; operator?: Operator } = {}) => {
    const job = makeJob({ num: 1040 + n, title: null, machineId, customer: null, endedAgo: m, minutes, usages, operator: opts.operator ?? [sara, david, nina][n % 3], adjustment: opts.adjustment, notes: 'Counter sale' });
    const payments = (opts.pays ?? []).map(([method, amount]) => pay(m, method, amount));
    state = counterSale(state, ctx(m, job.operator!.displayName), { job, extras: (opts.extras ?? []).map(([description, quantity, unit, unitPrice]) => ({ description, quantity, unit, unitPrice })), payments }).state;
  };
  sale(1, 9 * D + 4 * H, 'm-laser', 20, [[PLY, 0.3]], { pays: [['cash', 5.6]] });
  sale(2, 7 * D + 2 * H, 'm-mk4-1', 90, [[PLA, 60]], { pays: [['card', 13.8]] });
  sale(3, 5 * D + 6 * H, 'm-mk4-2', 45, [[PETG, 30]], { pays: [['cash', 4], ['card', 2.9]] });
  sale(4, 4 * D + 1 * H, 'm-x1c', 180, [[ASA, 120]], { extras: [['Bed adhesive stick', 1, 'piece', 5.5]], pays: [['card', 33.1]] });
  sale(5, 3 * D + 4 * H, 'm-cnc', 60, [[MDF, 0.25]], { adjustment: { kind: 'fixed', value: 0, reason: 'Demonstration for a school visit.' } });
  sale(6, 2 * D + 2 * H, 'm-laser', 30, [[PLY, 0.5]], { extras: [['Plywood offcut, A4 size', 1, 'piece', 1.5]], pays: [['cash', 5], ['card', 5.5]] });
  sale(7, 1 * D + 5 * H, 'm-mk4-1', 120, [[PLA, 100]], { adjustment: { kind: 'discount_percent', value: 10, reason: 'Regular visitor.' }, pays: [['cash', 18]] });
  sale(8, 2 * H + 10, 'm-h2d', 240, [[PETG, 150]], { pays: [['card', 36]] });
  sale(9, 55, 'm-mk4-2', 30, [[PLA, 25]], { pays: [['cash', 5]] });
  sale(10, 12, 'm-laser', 15, [[PLY, 0.2]], { extras: [['Screw assortment M3', 1, 'pack', 3]], pays: [['cash', 3], ['card', 3.9]] });

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
  const walkInDraft = draft(12 * D, null, 'Nina Berger'); manual(12 * D - 5, walkInDraft, 'PLA spool 1 kg, black', 1, 'piece', 19.9); manual(12 * D - 8, walkInDraft, 'Nozzle 0.4 mm, hardened', 1, 'piece', 12);
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

  // wiRef-backed orders ---------------------------------------------------------------------------------------------------
  const wiRefOrder = (party: BillingParty, m: number, ids: string[]) => {
    const id = draft(m, party, 'Nina Berger'); jobs(m - 4, id, ...ids); finalize(m - 6, id);
    const r = prepareInvoiceRequest(state, ctx(m - 60, 'Nina Berger'), id); state = r.state; return { id, request: state.requests.find((request) => request.id === r.requestId)! };
  };
  const wiRefDraft = wiRefOrder(robotics, 4 * D + 2 * H, ['j-1075', 'j-1074']);
  wiRefDraft.request.details = { ...wiRefDraft.request.details, addressLine1: 'Inffeldgasse 13', postalCode: '8010', locality: 'Graz' };

  const submitted = wiRefOrder(kreativ, 6 * D + 5 * H, ['j-1073']);
  Object.assign(submitted.request.details, { addressLine1: 'Schmiedgasse 8', postalCode: '8010', locality: 'Graz', contactName: 'Petra Lang', purchaseOrderReference: 'PO-2026-0412' });
  submitted.request.state = 'submitted';
  submitted.request.events.push({ id: 'we-s1', at: ago(6 * D + 3 * H), actor: 'Nina Berger', text: 'Marked as ready' }, { id: 'we-s2', at: ago(6 * D + 2 * H), actor: 'Nina Berger', text: 'Submitted to wiRef' });

  const issued = wiRefOrder(htl, 7 * D, ['j-1072']);
  Object.assign(issued.request.details, { addressLine1: 'Pestalozzistraße 3', postalCode: '8010', locality: 'Graz', contactName: 'Dr. Weber' });
  issued.request.state = 'issued';
  issued.request.events.push({ id: 'we-i1', at: ago(6 * D + 20 * H), actor: 'Nina Berger', text: 'Marked as ready' }, { id: 'we-i2', at: ago(6 * D + 18 * H), actor: 'Nina Berger', text: 'Submitted to wiRef' }, { id: 'we-i3', at: ago(5 * D + 6 * H), actor: 'Nina Berger', text: 'wiRef issued the invoice (R-2026-2201)' });
  record(2 * D + 5 * H, issued.id, pay(2 * D + 5 * H, 'external', totalOf(issued.id)));

  const cancelledRequest = wiRefOrder(fablab, 11 * D, ['j-1071']);
  cancelledRequest.request.state = 'cancelled';
  cancelledRequest.request.events.push({ id: 'we-c1', at: ago(9 * D), actor: 'Nina Berger', text: 'Request cancelled: the recipient asked for a different billing address' });
  state = reverseOrder(state, ctx(8 * D + 2 * H, 'Nina Berger'), cancelledRequest.id, { reason: 'Wrong billing details; to be charged again with the new address.', reversals: [] }).state;

  return state;
}

export const salesSeed = buildSalesSeed();
