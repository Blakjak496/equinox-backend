export type ParsedItemLine = {
  rawLine: string;
  name: string;
  quantity: number;
};

// Handles the paste formats EVE players actually use, rather than trying
// to guess at Janice's full undocumented tolerance: plain "Item Name
// Quantity" per line (this app's own documented format - see the
// itemsInput placeholder), and the EVE client's tab-separated
// inventory/cargo/contract window copy (name in the first column, a
// quantity integer somewhere in a later column, remaining columns -
// group/category/volume/etc - ignored). A line with no quantity anywhere
// on it (a bare item name paste) defaults to a quantity of 1, matching how
// EVE's own "Show Info" copy and similar tools behave.
export function parseItemsText(itemsText: string): ParsedItemLine[] {
  return itemsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseLine);
}

function parseLine(rawLine: string): ParsedItemLine {
  if (rawLine.includes("\t")) return parseTabSeparatedLine(rawLine);
  return parsePlainLine(rawLine);
}

function parseTabSeparatedLine(rawLine: string): ParsedItemLine {
  const columns = rawLine
    .split("\t")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);

  const name = columns[0] ?? rawLine;
  // EVE's inventory/cargo/contract copy puts quantity in the 2nd column,
  // but scan the rest defensively in case a client version reorders them.
  const quantityColumn = columns.slice(1).find((column) => parseQuantity(column) !== null);
  const quantity = quantityColumn ? (parseQuantity(quantityColumn) ?? 1) : 1;

  return { rawLine, name, quantity };
}

function parsePlainLine(rawLine: string): ParsedItemLine {
  // Trailing whitespace-separated quantity, e.g. "Tritanium 22,222".
  const match = rawLine.match(/^(.+?)\s+([\d,]+)$/);
  if (match) {
    const quantity = parseQuantity(match[2]);
    if (quantity !== null) {
      return { rawLine, name: match[1].trim(), quantity };
    }
  }
  // No trailing quantity at all - bare item name paste, quantity 1.
  return { rawLine, name: rawLine, quantity: 1 };
}

function parseQuantity(token: string): number | null {
  const cleaned = token.replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}
