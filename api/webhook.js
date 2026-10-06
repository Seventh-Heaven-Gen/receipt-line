import crypto from "node:crypto";
import { ocrReceipt } from "../lib/ocr.js";
import {
  appendItems,
  findLastReceipt,
  markReceiptDeleted,
} from "../lib/sheets.js";
import {
  ADMIN_USER_ID,
  INVITE_DAYS,
  WITHDRAW_DAYS,
  adoptAdmin,
  appendUsage,
  countThisMonth,
  createInvite,
  findUserByLine,
  inviteLocked,
  listActiveUsers,
  monthlyCounts,
  normalizeCode,
  recentFailureCount,
  recordInviteFailure,
  redeemInvite,
  startWithdraw,
} from "../lib/users.js";

export const config = {
  api: { bodyParser: false },
};

const monthlyLimit = () => Number(process.env.MONTHLY_LIMIT || 50);

const MSG = {
  inviteOnly: "招待制です。招待コードを送ってください。",
  badCode: "招待コードが正しくないか、期限が切れています。",
  locked: "試行回数が多すぎます。しばらくしてからお試しください。",
  welcome:
    "レシートの写真を送ると、品目を在庫に登録します。写真はGoogleのサービスに送信されます。当サービスでは保存しません。運営者は、利用枚数以外の中身は見ません。",
  help: "レシートの写真を送ってください。「在庫」と送ると、在庫ページのURLをお送りします。",
  ocrFail: "読み取れませんでした。もう一度撮影してください。",
  withdrawn: "退会処理が完了しています。ご利用ありがとうございました。",
  adminCannotWithdraw: "管理者アカウントは退会できません。",
  withdrawCanceled: "退会をキャンセルしました。",
  nothingToUndo: "取り消せるレシートがありません。",
  undoCanceled: "キャンセルしました。",
  undoAlready: "すでに取り消されています。",
};

// 全角・半角、空白、末尾の記号、カタカナ／ひらがなの違いを吸収してコマンドを比べる
function normalizeCommand(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[!?。．、,~〜♪]+$/u, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const COMMANDS = {
  stock: new Set(["在庫", "ざいこ"]),
  withdraw: new Set(["退会", "たいかい"]),
  undo: new Set([
    "取り消し",
    "取消",
    "取消し",
    "取り消す",
    "取り消して",
    "とりけし",
    "削除",
  ]),
};

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
    .createHmac("SHA256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(hash, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function replyMessage(replyToken, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).map((m) =>
    typeof m === "string" ? { type: "text", text: m } : m
  );
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: list }),
  });
}

async function getImageBuffer(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
  if (!res.ok) throw new Error(`LINE content API: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function baseUrl() {
  return (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    "localhost:3000"
  );
}
const inventoryUrl = (user) =>
  `https://${baseUrl()}/inventory?t=${user.page_token}`;
const exportUrl = (token) => `https://${baseUrl()}/api/export?t=${token}`;

const jpDate = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

function withdrawButtons() {
  const act = (label, data) => ({
    type: "postback",
    label,
    data,
    displayText: label,
  });
  return {
    type: "template",
    altText: "退会の確認",
    template: {
      type: "buttons",
      text: "本当に退会しますか？\n残っているデータをダウンロードしますか？",
      actions: [
        act("退会する・データほしい", "wd:want"),
        act("退会する・データいらない", "wd:no"),
        act("退会しない", "wd:cancel"),
      ],
    },
  };
}

function withdrawConfirm(kind) {
  return {
    type: "template",
    altText: "退会処理の最終確認",
    template: {
      type: "confirm",
      text: "退会処理を実行してよろしいですか？",
      actions: [
        { type: "postback", label: "はい", data: `wd_exec:${kind}`, displayText: "はい" },
        { type: "postback", label: "いいえ", data: "wd:cancel", displayText: "いいえ" },
      ],
    },
  };
}

async function handleImage(user, event) {
  if (user.user_id !== ADMIN_USER_ID) {
    const limit = monthlyLimit();
    const used = await countThisMonth(user.user_id);
    if (used >= limit) {
      await replyMessage(
        event.replyToken,
        `今月の上限（${limit}枚）に達しました。来月またご利用ください。`
      );
      return;
    }
  }

  try {
    const imageBuffer = await getImageBuffer(event.message.id);
    const { data, usage } = await ocrReceipt(imageBuffer);
    await appendUsage(user.user_id, usage.input, usage.output);

    if (!data.items || data.items.length === 0) {
      await replyMessage(event.replyToken, MSG.ocrFail);
      return;
    }

    const count = await appendItems(user.tab_name, data);
    const itemList = data.items
      .map((it) => `・${it.name} ¥${Number(it.price).toLocaleString()}`)
      .join("\n");
    const total = Number(data.total || 0).toLocaleString();

    await replyMessage(
      event.replyToken,
      `${data.store}（${data.date}）\n${count}品目を登録しました\n\n${itemList}\n\n合計 ¥${total}`
    );
  } catch (e) {
    console.error("handleImage error:", e);
    if (e.usage) {
      await appendUsage(user.user_id, e.usage.input, e.usage.output).catch(
        () => {}
      );
    }
    await replyMessage(event.replyToken, MSG.ocrFail);
  }
}

async function handleAdminText(text, replyToken) {
  if (text === "状況") {
    const [users, counts, failures] = await Promise.all([
      listActiveUsers(),
      monthlyCounts(),
      recentFailureCount(),
    ]);
    const lines = users.map((u) => {
      if (u.user_id === ADMIN_USER_ID) {
        return `・あなた: ${counts[u.user_id] || 0}枚（上限なし）`;
      }
      return `・${u.memo || u.user_id}: ${counts[u.user_id] || 0}枚`;
    });
    let reply = `今月の利用枚数（上限${monthlyLimit()}枚）\n${lines.join("\n") || "利用者なし"}`;
    if (failures > 0) {
      reply += `\n\n招待コードの失敗（直近1時間）: ${failures}回`;
    }
    await replyMessage(replyToken, reply);
    return true;
  }
  if (text === "招待" || text.startsWith("招待 ") || text.startsWith("招待　")) {
    const memo = text.slice(2).trim();
    const { code, expires_at } = await createInvite(memo);
    await replyMessage(
      replyToken,
      `招待コード: ${code}\n有効期限: ${jpDate(expires_at)}まで（${INVITE_DAYS}日間）\n友だちに、このコードをLINEで送ってもらってください。${memo ? `\nメモ: ${memo}` : ""}`
    );
    return true;
  }
  return false;
}

async function handleUndoRequest(user, replyToken) {
  const last = await findLastReceipt(user.tab_name);
  if (!last) {
    await replyMessage(replyToken, MSG.nothingToUndo);
    return;
  }
  const names = last.items.slice(0, 3).map((it) => it.item).join("、");
  const more = last.items.length > 3 ? " ほか" : "";
  const body =
    `直前のレシートを取り消しますか？\n${last.store}（${last.date}）\n${last.items.length}品目：${names}${more}`.slice(
      0,
      230
    );
  await replyMessage(replyToken, {
    type: "template",
    altText: "レシートの取り消しの確認",
    template: {
      type: "confirm",
      text: body,
      actions: [
        {
          type: "postback",
          label: "はい",
          data: `rc_undo:${last.created_at}`,
          displayText: "はい",
        },
        {
          type: "postback",
          label: "いいえ",
          data: "rc_undo_cancel",
          displayText: "いいえ",
        },
      ],
    },
  });
}

async function handleUndoExecute(user, createdAt, replyToken) {
  const removed = await markReceiptDeleted(user.tab_name, createdAt);
  if (removed.length === 0) {
    await replyMessage(replyToken, MSG.undoAlready);
    return;
  }
  await replyMessage(
    replyToken,
    `${removed[0].store}（${removed[0].date}）の${removed.length}品目を取り消しました。`
  );
}

async function handleText(user, text, replyToken, isAdmin) {
  if (isAdmin && (await handleAdminText(text, replyToken))) return;

  const cmd = normalizeCommand(text);

  if (COMMANDS.stock.has(cmd)) {
    await replyMessage(replyToken, inventoryUrl(user));
    return;
  }
  if (COMMANDS.undo.has(cmd)) {
    await handleUndoRequest(user, replyToken);
    return;
  }
  if (COMMANDS.withdraw.has(cmd)) {
    if (user.user_id === ADMIN_USER_ID) {
      await replyMessage(replyToken, MSG.adminCannotWithdraw);
      return;
    }
    await replyMessage(replyToken, withdrawButtons());
    return;
  }
  await replyMessage(replyToken, MSG.help);
}

async function handlePostback(user, data, replyToken) {
  if (data === "rc_undo_cancel") {
    await replyMessage(replyToken, MSG.undoCanceled);
    return;
  }
  if (data.startsWith("rc_undo:")) {
    await handleUndoExecute(user, data.slice("rc_undo:".length), replyToken);
    return;
  }
  if (data === "wd:cancel") {
    await replyMessage(replyToken, MSG.withdrawCanceled);
    return;
  }
  if (user.user_id === ADMIN_USER_ID) {
    await replyMessage(replyToken, MSG.adminCannotWithdraw);
    return;
  }
  if (data === "wd:want" || data === "wd:no") {
    await replyMessage(replyToken, withdrawConfirm(data.split(":")[1]));
    return;
  }
  if (data === "wd_exec:want" || data === "wd_exec:no") {
    const wantData = data === "wd_exec:want";
    const { delete_at, export_token } = await startWithdraw(user, wantData);
    let text = `退会処理を行いました。ご利用を停止し、データは${WITHDRAW_DAYS}日後（${jpDate(delete_at)}）に削除されます。`;
    if (wantData) {
      text += `\n\nデータのダウンロードURL（${WITHDRAW_DAYS}日間有効）:\n${exportUrl(export_token)}`;
    }
    await replyMessage(replyToken, text);
  }
}

async function handleUnregistered(userId, event) {
  const text = event.message?.type === "text" ? event.message.text : null;

  if (!process.env.ADMIN_LINE_USER_ID && text === "ID") {
    await replyMessage(
      event.replyToken,
      `あなたのLINEユーザーIDです。\n${userId}\nVercelの環境変数 ADMIN_LINE_USER_ID に設定してください。`
    );
    return;
  }

  if (text && normalizeCode(text)) {
    if (await inviteLocked(userId)) {
      await replyMessage(event.replyToken, MSG.locked);
      return;
    }
    const user = await redeemInvite(text, userId);
    if (!user) {
      await recordInviteFailure(userId);
      await replyMessage(event.replyToken, MSG.badCode);
      return;
    }
    await replyMessage(event.replyToken, [MSG.welcome, inventoryUrl(user)]);
    return;
  }

  if (event.replyToken) {
    await replyMessage(event.replyToken, MSG.inviteOnly);
  }
}

async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  if (event.type !== "message" && event.type !== "postback") return;

  const adminId = process.env.ADMIN_LINE_USER_ID;
  const isAdmin = Boolean(adminId) && userId === adminId;

  let user = await findUserByLine(userId);
  if (!user && isAdmin) user = await adoptAdmin(userId);

  if (!user) {
    if (event.type === "message") await handleUnregistered(userId, event);
    return;
  }

  if (user.status === "withdrawn") {
    await replyMessage(event.replyToken, MSG.withdrawn);
    return;
  }

  if (event.type === "postback") {
    await handlePostback(user, event.postback.data, event.replyToken);
    return;
  }

  if (event.message.type === "image") {
    await handleImage(user, event);
  } else if (event.message.type === "text") {
    await handleText(user, event.message.text.trim(), event.replyToken, isAdmin);
  }
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
  for (const event of body.events || []) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error("handleEvent error:", e);
    }
  }

  res.status(200).json({ ok: true });
}
