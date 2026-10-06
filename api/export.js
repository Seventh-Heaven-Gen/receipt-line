import { readTable } from "../lib/sheets.js";
import { findWithdrawnByExportToken } from "../lib/users.js";

const COLUMNS = ["date", "store", "item", "price", "used", "created_at"];
const LABELS = ["購入日", "店名", "品名", "金額", "使用済み", "登録日時"];

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");

  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const token =
    typeof req.query?.t === "string"
      ? req.query.t
      : new URL(req.url, "http://localhost").searchParams.get("t") || "";

  const user = await findWithdrawnByExportToken(token);
  if (!user) {
    return res
      .status(403)
      .setHeader("Content-Type", "text/plain; charset=utf-8")
      .send("このURLは無効か、期限が切れています。");
  }

  const { rows } = await readTable(user.tab_name);
  const lines = [LABELS.map(csvCell).join(",")];
  for (const r of rows) {
    if (r.deleted === "TRUE") continue;
    lines.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="receipt-data.csv"'
  );
  return res.status(200).send("﻿" + lines.join("\r\n") + "\r\n");
}
