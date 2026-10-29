export type ProgressAmountSummary = { scope: "fetched_records"; valueSum: string | null; valuedRecords: number; missingRecords: number; invalidRecords: number; currencyVerified: false };

// Sum the decimal values returned by Salesforce, without binary float rounding
// or replacing missing amounts with zero. Currency is deliberately unverified.
export function progressAmountSummary(rows: Record<string, unknown>[]): ProgressAmountSummary {
  const power = (places: number) => BigInt("1" + "0".repeat(places));
  let total = BigInt(0), scale = 0, valuedRecords = 0, missingRecords = 0, invalidRecords = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") { invalidRecords++; continue; }
    const value = row.Amount;
    if (value == null) { missingRecords++; continue; }
    if (typeof value !== "number" || !Number.isFinite(value)) { invalidRecords++; continue; }
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
    const decimalPlaces = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
    let digits = BigInt(mantissa.replace(".", "")), places = decimalPlaces - Number(exponent);
    if (places < 0) { digits *= power(-places); places = 0; }
    const nextScale = Math.max(scale, places);
    total = total * power(nextScale - scale) + digits * power(nextScale - places);
    scale = nextScale; valuedRecords++;
  }
  const negative = total < BigInt(0), digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const valueSum = (negative ? "-" : "") + (scale ? (digits.slice(0, -scale) + "." + digits.slice(-scale)).replace(/\.?0+$/, "") : digits);
  return { scope: "fetched_records", valueSum: valuedRecords ? valueSum : null, valuedRecords, missingRecords, invalidRecords, currencyVerified: false };
}
