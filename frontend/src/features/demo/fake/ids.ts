// Stable identifiers of the demo sample data. This file must not import the fixtures: guide content imports it from
// the initial bundle to link into demo pages, so it stays a few hundred bytes.
const id = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const DEMO_IDS = {
  /** The published Open Day period with upcoming days. */
  period: id(0x800),
  /** The first upcoming Open Day: it has free supervisor and trainee places. */
  openDay: id(0x801),
  /** Later Open Days of the period, in date order. */
  openDays: [id(0x801), id(0x802), id(0x803), id(0x804)],
  /** A finalized order that is not paid yet. */
  order: id(0x601),
  /** A finished, priced job that is not on an order yet. */
  job: id(0x401),
  /** Recorded runs that belong to no job yet. */
  unassignedRun: id(0x501),
  unassignedRun2: id(0x502),
  machines: { printer: id(0x101), printer2: id(0x102), laser: id(0x103) },
  customer: id(0x701),
  organization: id(0xc01),
  material: id(0x201),
} as const;

/** The identifier of the n-th entity created while demo mode runs: same shape, never colliding with the sample ids. */
export const createdDemoId = (n: number) => id(0x10000 + n);
export const sampleDemoId = id;
