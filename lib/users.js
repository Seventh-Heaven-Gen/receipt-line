import crypto from "node:crypto";
import {
  ITEM_HEADERS,
  ensureTab,
  readTable,
  appendRows,
  replaceRows,
  updateRowFields,
  updateCells,
  deleteTab,
} from "./sheets.js";

export const USERS_HEADERS = [
  "user_id",
  "line_user_id",
  "tab_name",
  "page_token",
  "export_token",
  "status",
  "memo",
  "created_at",
  "withdrawn_at",
  "delete_at",
];
export const INVITES_HEADERS = [
  "code",
  "memo",
  "created_at",
  "expires_at",
  "used_by_user_id",
  "used_at",
];
export const USAGE_HEADERS = [
  "timestamp",
  "user_id",
  "input_tokens",
  "output_tokens",
];

export const ATTEMPT_HEADERS = ["timestamp", "line_user_id"];

export const ADMIN_USER_ID = "u_admin";
const ATTEMPT_WINDOW_MS = 3600000;
const ATTEMPT_MAX_PER_USER = 5;
const ATTEMPT_MAX_TOTAL = 30;
const ATTEMPT_KEEP_MS = 86400000;
const LEGACY_TAB = "items";
const DAY = 86400000;
export const INVITE_DAYS = 14;
export const WITHDRAW_DAYS = 7;

let ready = false;
export async function init() {
  if (ready) return;
  await ensureTab("users", USERS_HEADERS);
  await ensureTab("invites", INVITES_HEADERS);
  await ensureTab("usage", USAGE_HEADERS);
  await ensureTab("invite_attempts", ATTEMPT_HEADERS);
  ready = true;
}
export function __resetForTest() {
  ready = false;
}

const nowIso = () => new Date().toISOString();
const randomToken = () => crypto.randomBytes(24).toString("base64url");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCode() {
  let s = "";
  for (let i = 0; i < 12; i++) {
    s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export function normalizeCode(text) {
  const t = String(text).normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(t)) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}`;
}

// 日本時間の「YYYY-MM」
export function jstMonth(input = new Date()) {
  const ms = new Date(input).getTime() + 9 * 3600000;
  return new Date(ms).toISOString().slice(0, 7);
}

async function usersTable() {
  await init();
  return readTable("users");
}

export async function findUserByLine(lineUserId) {
  const { rows } = await usersTable();
  return (
    rows.find((u) => u.line_user_id === lineUserId && u.status !== "deleted") ||
    null
  );
}

export async function findActiveByPageToken(token) {
  if (!token) return null;
  const { rows } = await usersTable();
  return rows.find((u) => u.page_token === token && u.status === "active") || null;
}

export async function findWithdrawnByExportToken(token) {
  if (!token) return null;
  const { rows } = await usersTable();
  return (
    rows.find(
      (u) =>
        u.export_token === token &&
        u.status === "withdrawn" &&
        Date.now() < Date.parse(u.delete_at)
    ) || null
  );
}

export async function createUser(lineUserId, memo = "") {
  await init();
  const userId = `u_${crypto.randomBytes(5).toString("hex")}`;
  await ensureTab(userId, ITEM_HEADERS);
  const user = {
    user_id: userId,
    line_user_id: lineUserId,
    tab_name: userId,
    page_token: randomToken(),
    export_token: "",
    status: "active",
    memo,
    created_at: nowIso(),
    withdrawn_at: "",
    delete_at: "",
  };
  await appendRows("users", USERS_HEADERS, [user]);
  return user;
}

// ななの既存データ（items タブ）をそのまま、ななの利用者データとして引き継ぐ
export async function adoptAdmin(lineUserId) {
  await init();
  await ensureTab(LEGACY_TAB, ITEM_HEADERS);
  const user = {
    user_id: ADMIN_USER_ID,
    line_user_id: lineUserId,
    tab_name: LEGACY_TAB,
    page_token: randomToken(),
    export_token: "",
    status: "active",
    memo: "なな",
    created_at: nowIso(),
    withdrawn_at: "",
    delete_at: "",
  };
  await appendRows("users", USERS_HEADERS, [user]);
  return user;
}

export async function createInvite(memo = "") {
  await init();
  const code = generateCode();
  const expires = new Date(Date.now() + INVITE_DAYS * DAY).toISOString();
  await appendRows("invites", INVITES_HEADERS, [
    {
      code,
      memo,
      created_at: nowIso(),
      expires_at: expires,
      used_by_user_id: "",
      used_at: "",
    },
  ]);
  return { code, expires_at: expires };
}

// 有効なコードなら利用者を作って返す。無効なら null
export async function redeemInvite(rawCode, lineUserId) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  await init();
  const { rows } = await readTable("invites");
  const invite = rows.find((r) => r.code === code);
  if (!invite) return null;
  if (invite.used_at) return null;
  if (Date.now() > Date.parse(invite.expires_at)) return null;

  const user = await createUser(lineUserId, invite.memo);
  await updateRowFields("invites", invite._row, INVITES_HEADERS, {
    used_by_user_id: user.user_id,
    used_at: nowIso(),
  });
  return user;
}

async function recentAttempts() {
  await init();
  const { rows } = await readTable("invite_attempts");
  return rows.filter(
    (r) => Date.now() - Date.parse(r.timestamp) < ATTEMPT_WINDOW_MS
  );
}

// 1時間以内の失敗が、本人5回 または 全体30回に達していたら、コードの照合自体をしない
export async function inviteLocked(lineUserId) {
  const recent = await recentAttempts();
  const mine = recent.filter((r) => r.line_user_id === lineUserId).length;
  return mine >= ATTEMPT_MAX_PER_USER || recent.length >= ATTEMPT_MAX_TOTAL;
}

export async function recordInviteFailure(lineUserId) {
  await init();
  await appendRows("invite_attempts", ATTEMPT_HEADERS, [
    { timestamp: nowIso(), line_user_id: lineUserId },
  ]);
}

export async function recentFailureCount() {
  return (await recentAttempts()).length;
}

// 24時間より古い失敗記録を消す
export async function pruneAttempts() {
  await init();
  const { rows } = await readTable("invite_attempts");
  const keep = rows
    .filter((r) => Date.now() - Date.parse(r.timestamp) < ATTEMPT_KEEP_MS)
    .map(({ _row, ...rest }) => rest);
  if (keep.length === rows.length) return 0;
  await replaceRows("invite_attempts", ATTEMPT_HEADERS, keep);
  return rows.length - keep.length;
}

export async function appendUsage(userId, inputTokens, outputTokens) {
  await init();
  await appendRows("usage", USAGE_HEADERS, [
    {
      timestamp: nowIso(),
      user_id: userId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  ]);
}

// 今月（日本時間）の利用枚数。{ user_id: 枚数 }
export async function monthlyCounts() {
  await init();
  const { rows } = await readTable("usage");
  const month = jstMonth();
  const counts = {};
  for (const r of rows) {
    if (!r.user_id || jstMonth(r.timestamp) !== month) continue;
    counts[r.user_id] = (counts[r.user_id] || 0) + 1;
  }
  return counts;
}

export async function countThisMonth(userId) {
  const counts = await monthlyCounts();
  return counts[userId] || 0;
}

export async function listActiveUsers() {
  const { rows } = await usersTable();
  return rows.filter((u) => u.status === "active");
}

export async function startWithdraw(user, wantData) {
  const deleteAt = new Date(Date.now() + WITHDRAW_DAYS * DAY).toISOString();
  const exportToken = wantData ? randomToken() : "";
  await updateRowFields("users", user._row, USERS_HEADERS, {
    status: "withdrawn",
    withdrawn_at: nowIso(),
    delete_at: deleteAt,
    export_token: exportToken,
  });
  return { delete_at: deleteAt, export_token: exportToken };
}

// 削除日を過ぎた退会者のタブを消し、本人に紐づく情報を消す。処理した人数を返す
export async function cleanupWithdrawn() {
  const { rows } = await usersTable();
  const due = rows.filter(
    (u) => u.status === "withdrawn" && Date.now() >= Date.parse(u.delete_at)
  );
  if (due.length === 0) return 0;

  const usage = await readTable("usage");
  const userIdCol = USAGE_HEADERS.indexOf("user_id");

  for (const u of due) {
    if (u.tab_name && u.tab_name !== LEGACY_TAB) {
      await deleteTab(u.tab_name);
    }
    const cells = usage.rows
      .filter((r) => r.user_id === u.user_id)
      .map((r) => ({ row: r._row, col: userIdCol, value: "" }));
    await updateCells("usage", cells);
    await updateRowFields("users", u._row, USERS_HEADERS, {
      line_user_id: "",
      tab_name: "",
      page_token: "",
      export_token: "",
      memo: "",
      status: "deleted",
    });
  }
  return due.length;
}
