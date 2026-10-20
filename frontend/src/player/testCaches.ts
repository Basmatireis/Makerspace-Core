import { Blob as NodeBlob } from 'node:buffer';

// A small in-memory CacheStorage for player tests. Keys are paths, as the player uses them.

type Entry = { body: ArrayBuffer; status: number; headers: [string, string][] };

const pathOf = (input: RequestInfo | URL) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, 'http://player.invalid').pathname;
};

export type FakeCaches = CacheStorage & {
  /** Paths stored in the named cache. */
  keysOf(name: string): string[];
  /** Makes every `put` into any cache throw a QuotaExceededError. */
  failPuts(value: boolean): void;
};

export function fakeCaches(): FakeCaches {
  const stores = new Map<string, Map<string, Entry>>();
  let failing = false;
  const open = (name: string) => {
    let entries = stores.get(name);
    if (!entries) { entries = new Map(); stores.set(name, entries); }
    const map = entries;
    return {
      async match(input: RequestInfo | URL) {
        const entry = map.get(pathOf(input));
        if (!entry) return undefined;
        const response = new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers });
        // jsdom's Blob is not accepted by the Response constructor of Node; hand out Node's.
        response.blob = async () => new NodeBlob([entry.body]) as unknown as Blob;
        return response;
      },
      async put(input: RequestInfo | URL, response: Response) {
        if (failing) throw new DOMException('full', 'QuotaExceededError');
        map.set(pathOf(input), { body: await response.arrayBuffer(), status: response.status, headers: [...response.headers.entries()] });
      },
      async delete(input: RequestInfo | URL) { return map.delete(pathOf(input)); },
      async keys() { return [...map.keys()].map((key) => new Request(`http://player.invalid${key}`)); },
    } as unknown as Cache;
  };
  return {
    open: async (name: string) => open(name),
    delete: async (name: string) => stores.delete(name),
    has: async (name: string) => stores.has(name),
    keys: async () => [...stores.keys()],
    match: async () => undefined,
    keysOf: (name: string) => [...(stores.get(name)?.keys() ?? [])],
    failPuts: (value: boolean) => { failing = value; },
  } as FakeCaches;
}
