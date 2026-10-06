import { getInventory, markUsed } from "../lib/sheets.js";

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { id } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!id) return res.status(400).json({ error: "id required" });

    const ok = await markUsed(id);
    if (!ok) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const items = await getInventory();

    const inStock = items.filter((it) => it.used !== "TRUE");
    const allItems = items;

    const byMonth = {};
    for (const it of allItems) {
      const month = (it.date || "").slice(0, 7);
      if (!month) continue;
      byMonth[month] = (byMonth[month] || 0) + Number(it.price || 0);
    }

    if (req.headers.accept?.includes("application/json")) {
      return res.status(200).json({ inStock, byMonth });
    }

    return res.status(200).send(buildHTML(inStock, byMonth));
  }

  res.status(405).send("Method Not Allowed");
}

function buildHTML(inStock, byMonth) {
  const grouped = {};
  for (const it of inStock) {
    const key = `${it.store}（${it.date}）`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(it);
  }

  const storeBlocks = Object.entries(grouped)
    .map(
      ([store, items]) => `
      <div class="store">
        <h2>${esc(store)}</h2>
        ${items
          .map(
            (it) => `
          <div class="item" data-id="${esc(it.id)}">
            <span class="name">${esc(it.item)}</span>
            <span class="price">¥${Number(it.price).toLocaleString()}</span>
          </div>`
          )
          .join("")}
      </div>`
    )
    .join("");

  const monthRows = Object.entries(byMonth)
    .sort()
    .reverse()
    .map(
      ([m, total]) =>
        `<tr><td>${esc(m)}</td><td>¥${total.toLocaleString()}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>在庫</title>
<style>
:root {
  --bg: #fff; --fg: #222; --card: #f7f7f7; --border: #e0e0e0;
  --accent: #2d7d46; --used: #bbb; --price: #666;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #1a1a1a; --fg: #e0e0e0; --card: #252525; --border: #333;
    --accent: #5cb87a; --used: #555; --price: #999;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
  background: var(--bg); color: var(--fg);
  padding: 16px; max-width: 480px; margin: 0 auto;
}
h1 { font-size: 1.3rem; margin-bottom: 12px; }
.tabs { display: flex; gap: 0; margin-bottom: 16px; }
.tab {
  flex: 1; text-align: center; padding: 10px; cursor: pointer;
  border-bottom: 2px solid var(--border); font-weight: 500;
}
.tab.active { border-bottom-color: var(--accent); color: var(--accent); }
.panel { display: none; }
.panel.active { display: block; }
.store { margin-bottom: 16px; }
.store h2 { font-size: 0.85rem; color: var(--price); margin-bottom: 6px; }
.item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px; margin-bottom: 4px; border-radius: 8px;
  background: var(--card); cursor: pointer; transition: opacity 0.2s;
  -webkit-user-select: none; user-select: none;
}
.item:active { opacity: 0.7; }
.item.done { opacity: 0.4; text-decoration: line-through; pointer-events: none; }
.name { font-size: 1rem; }
.price { font-size: 0.9rem; color: var(--price); white-space: nowrap; }
.empty { color: var(--price); text-align: center; padding: 40px 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
th { font-size: 0.85rem; color: var(--price); }
td:last-child, th:last-child { text-align: right; }
.confirm {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: var(--card); border-top: 1px solid var(--border);
  padding: 16px; display: none; text-align: center;
}
.confirm.show { display: block; }
.confirm p { margin-bottom: 12px; font-size: 0.95rem; }
.confirm button {
  padding: 10px 24px; border: none; border-radius: 8px; font-size: 1rem;
  cursor: pointer; margin: 0 6px;
}
.btn-yes { background: var(--accent); color: #fff; }
.btn-no { background: var(--border); color: var(--fg); }
</style>
</head>
<body>
<h1>在庫</h1>
<div class="tabs">
  <div class="tab active" data-tab="stock">在庫リスト</div>
  <div class="tab" data-tab="monthly">月次集計</div>
</div>
<div id="stock" class="panel active">
  ${inStock.length === 0 ? '<div class="empty">在庫なし</div>' : storeBlocks}
</div>
<div id="monthly" class="panel">
  <table>
    <thead><tr><th>月</th><th>合計</th></tr></thead>
    <tbody>${monthRows || '<tr><td colspan="2" style="text-align:center">データなし</td></tr>'}</tbody>
  </table>
</div>
<div class="confirm" id="confirm">
  <p id="confirm-text"></p>
  <button class="btn-yes" id="btn-yes">使った</button>
  <button class="btn-no" id="btn-no">まだ</button>
</div>
<script>
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

let pendingId = null;
const confirm = document.getElementById('confirm');
const confirmText = document.getElementById('confirm-text');

document.querySelectorAll('.item').forEach(el => {
  el.addEventListener('click', () => {
    pendingId = el.dataset.id;
    confirmText.textContent = el.querySelector('.name').textContent + ' 使った？';
    confirm.classList.add('show');
  });
});

document.getElementById('btn-no').addEventListener('click', () => {
  pendingId = null;
  confirm.classList.remove('show');
});

document.getElementById('btn-yes').addEventListener('click', async () => {
  if (!pendingId) return;
  const id = pendingId;
  confirm.classList.remove('show');
  const el = document.querySelector('[data-id="' + id + '"]');
  if (el) el.classList.add('done');

  await fetch('/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  pendingId = null;
});
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
