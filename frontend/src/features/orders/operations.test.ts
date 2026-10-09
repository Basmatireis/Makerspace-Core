import { describe, expect, it } from "vitest";
import { cents, operationKey } from "./operations";
import { formatMoney } from "./formatting";

describe("financial decimal display and operation identifiers", () => {
  it("preserves monetary digits above the safe integer limit", () => {
    expect(formatMoney("999999999999999999.99")).toBe(
      "€999,999,999,999,999,999.99",
    );
    expect(formatMoney("-0.50")).toBe("-€0.50");
    expect(formatMoney("10")).toBe("€10.00");
    expect(cents("999999999999999999.99") + cents("-0.50")).toBe(
      99999999999999999949n,
    );
  });
  it("generates distinct UUIDv7 retry identifiers", () => {
    const first = operationKey();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(operationKey()).not.toBe(first);
  });
});
