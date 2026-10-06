import { google } from "googleapis";

export const ITEM_HEADERS = [
  "id",
  "date",
  "store",
  "item",
  "price",
  "used",
  "created_at",
];

let injectedClient = null;
export function __setSheetsClient(client) {
  injectedClient = client;
  knownTabs.clear();
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
  if (!target) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid(),
    requestBody: { requests: [{ deleteSheet: { sheetId: target.sheetId } }] },
  });
  return true;
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
  }));

  await appendRows(tab, ITEM_HEADERS, objs);
  return objs.length;
}

export async function getInventory(tab) {
  const { rows } = await readTable(tab);
  return rows.map(({ _row, ...rest }) => rest);
}

export async function markUsed(tab, itemId, used = true) {
  const { headers, rows } = await readTable(tab);
  const target = rows.find((r) => r.id === itemId);
  if (!target) return false;
  await updateRowFields(tab, target._row, headers, {
    used: used ? "TRUE" : "FALSE",
  });
  return true;
}
