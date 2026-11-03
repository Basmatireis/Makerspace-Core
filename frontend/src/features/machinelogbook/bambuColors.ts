/**
 * Official colour names of Bambu Lab filament by product code.
 *
 * Bambu printers report the product code of a tagged spool as `tray_id_name`, for example "A00-K0": the part before
 * the dash names the product line (A00 = PLA Basic, G02 = PETG HF, ...), the suffix the colour. The suffix is not a
 * global colour code: "B0" is Sky Blue in PLA Matte but Cyan in PLA Lite, so names are looked up by the whole code.
 * Older tags write the number with two digits ("A00-K00"); both forms are accepted.
 *
 * Source: the community Bambu Lab RFID Library (https://github.com/queengooborg/Bambu-Lab-RFID-Library, README
 * tables per product line, read 2026-11-03), which collects the variant id and the Bambu store colour name of scanned
 * spools; the tag format (variant id = product code, material id = `tray_info_idx`) is documented in
 * https://github.com/Bambu-Research-Group/RFID-Tag-Guide. Bambu Lab publishes no code list of its own. Codes that the
 * library lists for two different colour names are left out, as are support materials, so a name here is either
 * right or absent. Names are a prefill that staff confirm; never a stock or identity authority.
 *
 * One line per product line (the prefix, its name, a colon, then "code name" pairs separated by commas); a product
 * line may continue on further lines.
 */
const CATALOGUE = `
A00 PLA Basic: B1 Blue Gray, B3 Cobalt Blue, B5 Turquoise, B8 Cyan, B9 Blue, D0 Gray, D1 Silver, D2 Light Gray
A00 PLA Basic: D3 Dark Gray, G0 Green, G1 Bambu Green, G2 Mistletoe Green, G3 Bright Green, G6 Bambu Green, K0 Black
A00 PLA Basic: N0 Brown, N1 Cocoa Brown, P0 Beige, P1 Pink, P2 Indigo Purple, P5 Purple, P6 Magenta, R0 Red
A00 PLA Basic: R2 Maroon Red, R3 Hot Pink, W1 Jade White, Y0 Yellow, Y2 Sunflower Yellow, Y3 Bronze, Y4 Gold
A00 PLA Basic Gradient: M0 Arctic Whisper, M2 Ocean to Meadow, M3 Pink Citrus, M4 Mint Lime, M5 Blueberry Bubblegum
A00 PLA Basic Gradient: M6 Dusk Glare, M7 Cotton Candy Cloud
A01 PLA Matte: B0 Sky Blue, B3 Marine Blue, B4 Ice Blue, B6 Dark Blue, D0 Nardo Gray, D3 Ash Gray, G0 Apple Green
A01 PLA Matte: G1 Grass Green, G7 Dark Green, K1 Charcoal, N0 Dark Chocolate, N1 Latte Brown, N2 Dark Brown, N3 Caramel
A01 PLA Matte: P3 Sakura Pink, P4 Lilac Purple, R1 Scarlet Red, R2 Terracotta, R3 Plum, R4 Dark Red, W2 Ivory White
A01 PLA Matte: W3 Bone White, Y2 Lemon Yellow, Y3 Desert Tan
A02 PLA Metal: B2 Cobalt Blue Metallic, D2 Iron Gray Metallic, G2 Oxide Green Metallic, N3 Copper Brown Metallic
A02 PLA Metal: Y1 Iridium Gold Metallic
A05 PLA Silk Multi-Color: M1 South Beach, M8 Dawn Radiance, T1 Gilded Rose, T2 Midnight Blaze, T4 Blue Hawaii
A05 PLA Silk Multi-Color: T5 Velvet Eclipse, T7 Mystic Magenta, T9 Phantom Blue
A06 PLA Silk+: B0 Baby Blue, B1 Blue, D1 Silver, G0 Candy Green, G1 Mint, P0 Purple, R0 Candy Red, R1 Rose Gold
A06 PLA Silk+: R2 Pink, W0 White, Y0 Champagne, Y1 Gold
A07 PLA Marble: D4 White Marble, R5 Red Granite
A08 PLA Sparkle: B7 Royal Purple Sparkle, D5 Slate Gray Sparkle, G3 Alpine Green Sparkle, K2 Onyx Black Sparkle
A08 PLA Sparkle: R2 Crimson Red Sparkle, Y1 Classic Gold Sparkle
A09 PLA Tough: A0 Orange, B4 Light Blue, B5 Lavender Blue, D1 Silver, K0 Black, R3 Vermilion Red, Y0 Yellow
A10 PLA Tough+: A0 Orange, B0 Cyan, D0 Gray, D1 Silver, K0 Black, W0 White, Y0 Yellow
A11 PLA Aero: K0 Black, W0 White
A12 PLA Glow: A0 Glow Orange, B0 Glow Blue, G0 Glow Green, R0 Glow Pink, Y0 Glow Yellow
A15 PLA Galaxy: B0 Purple, G0 Green, G1 Nebulae, R0 Brown
A16 PLA Wood: G0 Classic Birch, K0 Black Walnut, N0 Clay Brown, W0 White Oak, Y0 Ochre Yellow
A17 PLA Translucent: A0 Orange, B0 Ice Blue, B1 Blue, B2 Teal, G0 Light Jade, P0 Purple, P1 Lavender, R0 Red
A17 PLA Translucent: R1 Cherry Pink, Y0 Mellow Yellow
A18 PLA Lite: A1 Orange, B0 Cyan, B1 Blue, D0 Gray, G1 Green, K0 Black, P0 Matte Beige, R0 Red, W0 White, Y0 Yellow
A18 PLA Lite: Y1 Sunflower Yellow
A19 PLA Pure: A0 Apricot, B0 Baby Blue, K0 Absolute Black, P0 Milky Pink, W0 Pure White
A50 PLA-CF: B6 Royal Blue, B9 Jeans Blue, D6 Lava Gray, G7 Matcha Green, K0 Black, P7 Iris Purple, R4 Burgundy Red
G00 PETG Basic: A0 Orange, B0 Reflex Blue, B1 Navy Blue, C1 Clear, D0 Gray, D1 Misty Blue, G0 Green, G1 Pine Green
G00 PETG Basic: G8 Lime Green, K0 Black, N0 Dark Brown, R0 Red, W0 White, Y0 Yellow, Y1 Dark Beige
G01 PETG Translucent: A0 Translucent Orange, B0 Translucent Light Blue, C0 Clear, D0 Translucent Gray
G01 PETG Translucent: G0 Translucent Olive, G1 Translucent Teal, N0 Translucent Brown, P0 Translucent Purple
G01 PETG Translucent: P1 Translucent Pink
G02 PETG HF: B0 Blue, B1 Lake Blue, D0 Gray, D1 Dark Gray, G0 Green, G1 Lime Green, G2 Forest Green, K0 Black
G02 PETG HF: N1 Peanut Brown, R0 Red, W0 White, Y0 Yellow, Y1 Cream
G03 PETG Matte: B0 Baby Blue, D0 Gray, G1 Avocado Green, K0 Black, P0 Pink, W0 White
G50 PETG-CF: B6 Indigo Blue, D6 Titan Gray, G7 Malachite Green, K0 Black, P7 Violet Purple, R4 Brick Red
B00 ABS: A0 Orange, B0 Blue, B4 Azure, B6 Navy Blue, D1 Silver, G6 Bambu Green, G7 Olive, K0 Black, P4 Lavender
B00 ABS: R0 Red, W0 White, Y0 Yellow, Y1 Tangerine Yellow
B01 ASA: B0 Blue, D0 Gray, G0 Green, K0 Black, R0 Red, W0 White
B02 ASA Aero: W0 White
B50 ABS-GF: A0 Orange, K0 Black, R0 Red, W0 White
B51 ASA-CF: K0 Black
C00 PC: C0 Clear Black, K0 Black, W0 White
C01 PC FR: D0 Gray, K0 Black, W0 White
N04 PAHT-CF: K0 Black
N08 PA6-GF: B0 Blue, D0 White, D1 Gray, G0 Lime, K0 Black, N0 Brown, R0 Orange, Y0 Yellow
U02 TPU for AMS: B0 Blue, D0 Gray, G0 Neon Green, K0 Black, R0 Red, W0 White, Y0 Yellow
`;

/** "A00-K0" split into product line "A00" and colour code "K0"; the number without leading zeros ("K00" is "K0"). */
const PRODUCT_CODE = /^([A-Z]\d{2})-([A-Z])0*(\d+)$/;

function parseCatalogue(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [head, entries] = line.split(':');
    if (!entries) continue;
    const prefix = head.slice(0, 3);
    for (const entry of entries.split(',')) {
      const [code, ...name] = entry.trim().split(' ');
      const key = `${prefix}-${code}`;
      if (names.has(key)) throw new Error(`Bambu colour catalogue lists ${key} twice`);
      names.set(key, name.join(' '));
    }
  }
  return names;
}

const NAMES = parseCatalogue(CATALOGUE);

/** The official Bambu Lab colour name of a reported product code ("A00-K0", also "A00-K00"); null when unknown. */
export function bambuColorName(productCode: string | null | undefined): string | null {
  const match = PRODUCT_CODE.exec((productCode ?? '').trim().toUpperCase());
  if (!match) return null;
  return NAMES.get(`${match[1]}-${match[2]}${match[3]}`) ?? null;
}
