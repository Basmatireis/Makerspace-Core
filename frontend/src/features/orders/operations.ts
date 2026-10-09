import { useRef } from "react";
export const financeKeys = ["orders"] as const;
export function operationKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function useOperationKeys() {
  const keys = useRef(new Map<string, string>());
  return (action: string, input: unknown) => {
    const signature = `${action}:${JSON.stringify(input)}`;
    let key = keys.current.get(signature);
    if (!key) {
      key = operationKey();
      keys.current.set(signature, key);
    }
    return key;
  };
}

export function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}
