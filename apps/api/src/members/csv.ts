/**
 * Minimal RFC 4180 CSV parser (no external deps).
 * Handles quoted fields, embedded commas/quotes/newlines, CRLF, and
 * ragged rows (returned as-is; callers validate column counts).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // ignore CR; row ends at LF
    } else {
      field += ch;
    }
  }
  // trailing field/row (no final newline)
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  // drop fully-empty trailing rows
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.every((c) => c.trim() === '')
  ) {
    rows.pop();
  }
  return rows;
}
