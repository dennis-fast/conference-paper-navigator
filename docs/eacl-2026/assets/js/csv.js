// csv.js
export function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }

    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
      row = []; i++; continue;
    }

    field += c; i++;
  }

  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
  return rows;
}

export function toCSV(headers, records) {
  const esc = (s) => {
    const str = String(s ?? '');
    if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
    return str;
  };
  const lines = [];
  lines.push(headers.map(esc).join(','));
  for (const rec of records) {
    lines.push(headers.map(h => esc(rec[h])).join(','));
  }
  return lines.join('\n');
}

export function downloadText(filename, text, mime="text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function norm(s) {
  return String(s ?? '').trim();
}

export function normKey(s) {
  return String(s ?? '')
    .trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '');
}

export function detectColumns(headers) {
  const H = headers.map(normKey);
  const idx = (aliases) => {
    for (const a of aliases) {
      const ai = H.indexOf(normKey(a));
      if (ai !== -1) return headers[ai];
      // fallback: substring
      const sub = H.findIndex(h => h.includes(normKey(a)));
      if (sub !== -1) return headers[sub];
    }
    return null;
  };

  return {
    id: idx(["Paper number","id","paper id","submission id","program id"]),
    title: idx(["Title","paper title","title"]),
    abstract: idx(["Abstract","paper abstract"]),
    authors: idx(["Authors Names","authors","author list"]),
    presenter: idx(["Presenters Name","presenter","presenting author","speaker"]),
    session: idx(["Session","session"]),
    location: idx(["Room Location","location","room","hall"]),
    date: idx(["Session Date","date","day"]),
    time: idx(["Session time","time"]),
    order: idx(["Order","presentation order","order within session"]),
    cat1: idx(["category_primary"]),
    cat2: idx(["category_secondary"]),
    keywords: idx(["keywords"])
  };
}
