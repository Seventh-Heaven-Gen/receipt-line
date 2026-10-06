import crypto from "node:crypto";
import { ocrReceipt } from "../lib/ocr.js";
import { appendItems } from "../lib/sheets.js";

export const config = {
  api: { bodyParser: false },
};

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(hash, "utf8"),
    Buffer.from(signature, "utf8")
  );
}

async function replyMessage(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

async function getImageBuffer(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`LINE content API: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function handleImage(messageId, replyToken) {
  try {
    const imageBuffer = await getImageBuffer(messageId);
    const result = await ocrReceipt(imageBuffer);

    if (!result.items || result.items.length === 0) {
      await replyMessage(replyToken, "読めんかった。もっかい撮ってみて");
      return;
    }

    const count = await appendItems(result);

    const itemList = result.items
      .map((it) => `・${it.name} ¥${it.price.toLocaleString()}`)
      .join("\n");

    await replyMessage(
      replyToken,
      `${result.store}（${result.date}）\n${count}品目登録したで\n\n${itemList}\n\n合計 ¥${result.total.toLocaleString()}`
    );
  } catch (e) {
    console.error("handleImage error:", e);
    await replyMessage(replyToken, "読めんかった。もっかい撮ってみて");
  }
}

async function handleText(text, replyToken) {
  if (text === "在庫" || text === "ざいこ") {
    const baseUrl =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL ||
      "localhost:3000";
    const url = `https://${baseUrl}/inventory`;
    await replyMessage(replyToken, url);
    return;
  }

  await replyMessage(
    replyToken,
    "レシートの写真を送ってな。「在庫」って送ったら在庫ページのURL返すで"
  );
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"];

  if (!signature || !verifySignature(rawBody, signature)) {
    return res.status(403).send("Invalid signature");
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  const events = body.events || [];

  for (const event of events) {
    if (event.type !== "message") continue;

    if (event.message.type === "image") {
      await handleImage(event.message.id, event.replyToken);
    } else if (event.message.type === "text") {
      await handleText(event.message.text, event.replyToken);
    }
  }

  res.status(200).json({ ok: true });
}
