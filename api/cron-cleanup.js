import { cleanupWithdrawn, pruneAttempts } from "../lib/users.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).send("Unauthorized");
  }
  const cleaned = await cleanupWithdrawn();
  const pruned = await pruneAttempts();
  return res.status(200).json({ ok: true, cleaned, pruned });
}
