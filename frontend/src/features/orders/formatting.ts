const euro = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
});

// Money crosses the API as decimal strings. Keep all significant digits when
// displaying amounts beyond JavaScript's safe integer range.
export function formatMoney(value: string | null | undefined): string {
  if (value == null) return "—";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const rendered = euro
    .formatToParts(BigInt(whole))
    .map((part) =>
      part.type === "fraction" ? fraction.padEnd(2, "0") : part.value,
    )
    .join("");
  return negative ? `-${rendered}` : rendered;
}
