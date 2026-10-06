import { GoogleGenAI } from "@google/genai";

const PROMPT = `この画像は日本のレシートです。以下の情報をJSON形式で抽出してください。

## 抽出ルール
- store: 店名（支店名があれば含める）
- date: 購入日（YYYY-MM-DD形式）
- items: 購入品目の配列。各要素は {name: 品名, price: 税込金額(整数)}
- total: 合計金額（税込、整数）

## 除外ルール（itemsに含めないもの）
- レジ袋、袋代
- ポイント値引き、割引
- 小計、合計、税額、買上点数の行

## 出力
JSONのみ。説明文は不要。
\`\`\`json
{
  "store": "...",
  "date": "YYYY-MM-DD",
  "items": [
    {"name": "...", "price": 0}
  ],
  "total": 0
}
\`\`\``;

export async function ocrReceipt(imageBuffer, mimeType = "image/jpeg") {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const base64 = imageBuffer.toString("base64");

  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: PROMPT },
        ],
      },
    ],
  });

  let text = response.text.trim();
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
  }
  if (text.endsWith("```")) {
    text = text.slice(0, text.lastIndexOf("```"));
  }
  return JSON.parse(text.trim());
}
