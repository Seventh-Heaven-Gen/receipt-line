import { google } from "googleapis";

export const ITEM_HEADERS = [
  "id",
  "date",
  "store",
  "item",
  "price",
  "used",
  "created_at",
  "deleted",
];

let injectedClient = null;
export function __setSheetsClient(client) {
  injectedClient = client;
  knownTabs.clear();
  columnCache.clear();
}

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(
    /\\n/g,
    "\n"
  );
  return new google.auth.JWT(email, null, key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
}

function getSheets() {
  if (injectedClient) return injectedClient;
  return google.sheets({ version: "v4", auth: getAuth() });
}

const sid = () => process.env.GOOGLE_SHEETS_ID;
const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

export function colLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const knownTabs = new Set();
const columnCache = new Map();

async function tabProps(sheets) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sid(),
    fields: "sheets.properties(sheetId,title)",
  });
  return (res.data.sheets || []).map((s) => s.properties);
}

export async function ensureTab(title, headers) {
  if (knownTabs.has(title)) return;
  const sheets = getSheets();
  const props = await tabProps(sheets);
  if (!props.some((p) => p.title === title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid(),
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid(),
      range: `${q(title)}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
  knownTabs.add(title);
}

export async function deleteTab(title) {
  const sheets = getSheets();
  const props = await tabProps(sheets);
  const target = props.find((p) => p.title === title);
  knownTabs.delete(title);
  columnCache.delete(title);
  if (!target) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid(),
    requestBody: { requests: [{ deleteSheet: { sheetId: target.sheetId } }] },
  });
  return true;
}

// 見出し行に列がなければ右端に足す（あとから増えた列を、既存のタブにも反映する）。見出しの一覧を返す
export async function ensureColumn(tab, name) {
  const cached = columnCache.get(tab);
  if (cached && cached.includes(name)) return cached;

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sid(),
    range: `${q(tab)}!A1:Z1`,
  });
  const headers = ((res.data.values || [])[0] || []).map((h) => String(h).trim());
  if (!headers.includes(name)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid(),
      range: `${q(tab)}!${colLetter(headers.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [[name]] },
    });
    headers.push(name);
  }
  columnCache.set(tab, headers);
  return headers;
}

// 見出しの前後の空白を削る（スプシ側の見出しに空白が混ざっても動くように）
export async function readTable(tab) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sid(),
    range: `${q(tab)}!A:Z`,
  });
  const values = res.data.values || [];
  if (values.length === 0) return { headers: [], rows: [] };
  const headers = values[0].map((h) => String(h).trim());
  const rows = values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, j) => (obj[h] = row[j] === undefined ? "" : row[j]));
    return obj;
  });
  return { headers, rows };
}

export async function appendRows(tab, headers, objs) {
  if (objs.length === 0) return;
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sid(),
    range: `${q(tab)}!A:${colLetter(headers.length - 1)}`,
    valueInputOption: "RAW",
    requestBody: {
      values: objs.map((o) => headers.map((h) => (o[h] === undefined ? "" : o[h]))),
    },
  });
}

// 2行目以降を、渡した内容で置き換える
export async function replaceRows(tab, headers, objs) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sid(),
    range: `${q(tab)}!A2:${colLetter(headers.length - 1)}`,
  });
  if (objs.length === 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid(),
    range: `${q(tab)}!A2`,
    valueInputOption: "RAW",
    requestBody: {
      values: objs.map((o) => headers.map((h) => (o[h] === undefined ? "" : o[h]))),
    },
  });
}

// cells: [{ row, col, value }]  row は1始まり、col は0始まり
export async function updateCells(tab, cells) {
  if (cells.length === 0) return;
  const sheets = getSheets();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid(),
    requestBody: {
      valueInputOption: "RAW",
      data: cells.map((c) => ({
        range: `${q(tab)}!${colLetter(c.col)}${c.row}`,
        values: [[c.value]],
      })),
    },
  });
}

export async function updateRowFields(tab, row, headers, patch) {
  const cells = Object.entries(patch).map(([key, value]) => {
    const col = headers.indexOf(key);
    if (col < 0) throw new Error(`column not found: ${tab}.${key}`);
    return { row, col, value };
  });
  await updateCells(tab, cells);
}

export async function appendItems(tab, receiptData) {
  const sheets = getSheets();
  const now = new Date().toISOString();
  const datePrefix = receiptData.date.replace(/-/g, "");

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sid(),
    range: `${q(tab)}!A:A`,
  });
  const rowCount = existing.data.values ? existing.data.values.length : 0;

  const objs = receiptData.items.map((item, i) => ({
    id: `${datePrefix}-${String(rowCount + i).padStart(3, "0")}`,
    date: receiptData.date,
    store: receiptData.store,
    item: item.name,
    price: item.price,
    used: "FALSE",
    created_at: now,
    deleted: "",
  }));

  const headers = await ensureColumn(tab, "deleted");
  await appendRows(tab, headers, objs);
  return objs.length;
}

const isDeleted = (r) => r.deleted === "TRUE";

export async function getInventory(tab) {
  const { rows } = await readTable(tab);
  return rows.filter((r) => !isDeleted(r)).map(({ _row, ...rest }) => rest);
}

// 削除されていない最新のレシート（同じ created_at の品目を1枚とみなす）
export async function findLastReceipt(tab) {
  const { rows } = await readTable(tab);
  const live = rows.filter((r) => !isDeleted(r) && r.created_at);
  if (live.length === 0) return null;
  const latest = live.reduce((a, r) => (r.created_at > a ? r.created_at : a), "");
  const items = live.filter((r) => r.created_at === latest);
  return {
    created_at: latest,
    store: items[0].store,
    date: items[0].date,
    items: items.map(({ _row, ...rest }) => rest),
  };
}

// 該当レシートの品目に削除フラグを立てる。立てた行を返す（なければ空配列）
export async function markReceiptDeleted(tab, createdAt) {
  const headers = await ensureColumn(tab, "deleted");
  const { rows } = await readTable(tab);
  const targets = rows.filter((r) => r.created_at === createdAt && !isDeleted(r));
  if (targets.length === 0) return [];
  const col = headers.indexOf("deleted");
  await updateCells(
    tab,
    targets.map((r) => ({ row: r._row, col, value: "TRUE" }))
  );
  return targets;
}

export async function markUsed(tab, itemId, used = true) {
  const { headers, rows } = await readTable(tab);
  const target = rows.find((r) => r.id === itemId && !isDeleted(r));
  if (!target) return false;
  await updateRowFields(tab, target._row, headers, {
    used: used ? "TRUE" : "FALSE",
  });
  return true;
}
