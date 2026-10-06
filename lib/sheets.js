import { google } from "googleapis";

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
  return google.sheets({ version: "v4", auth: getAuth() });
}

export async function appendItems(receiptData) {
  const sheets = getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const now = new Date().toISOString();
  const datePrefix = receiptData.date.replace(/-/g, "");

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "items!A:A",
  });
  const rowCount = existing.data.values ? existing.data.values.length : 0;

  const rows = receiptData.items.map((item, i) => {
    const seq = String(rowCount + i).padStart(3, "0");
    const id = `${datePrefix}-${seq}`;
    return [
      id,
      receiptData.date,
      receiptData.store,
      item.name,
      item.price,
      "FALSE",
      now,
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "items!A:G",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  return rows.length;
}

export async function getInventory() {
  const sheets = getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "items!A:G",
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

export async function markUsed(itemId, used = true) {
  const sheets = getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "items!A:G",
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === itemId);
  if (rowIndex < 0) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `items!F${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[used ? "TRUE" : "FALSE"]] },
  });

  return true;
}
