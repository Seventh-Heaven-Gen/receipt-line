"""v0: レシート画像を Gemini Vision に投げて、品目JSONが正しく返るかテストする。
使い方: python ocr_test.py ../receipt_sample.jpg
"""

import argparse
import base64
import json
import sys
from pathlib import Path

import truststore
truststore.inject_into_ssl()  # Windowsのネイティブ証明書ストアを使う

# .env を探す順: receipt-line → x_post_maker → nuko-explainer
PARENT = Path(__file__).resolve().parent.parent
ENV_CANDIDATES = [
    Path(__file__).resolve().parent / ".env",
    PARENT / "x_post_maker" / ".env",
    PARENT / "nuko-explainer" / ".env",
]


def load_api_key() -> str:
    for env_path in ENV_CANDIDATES:
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("GEMINI_API_KEY="):
                key = line.split("=", 1)[1].strip()
                # 39文字前後が正常なキー長。2つくっついてる場合は後ろを使う
                if len(key) > 50 and "AIza" in key[10:]:
                    key = "AIza" + key.split("AIza")[-1]
                if key:
                    return key
    sys.exit("GEMINI_API_KEY がどの .env にも無い")


PROMPT = """\
この画像は日本のレシートです。以下の情報をJSON形式で抽出してください。

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
```json
{
  "store": "...",
  "date": "YYYY-MM-DD",
  "items": [
    {"name": "...", "price": 0}
  ],
  "total": 0
}
```
"""


def ocr_receipt(image_path: Path) -> dict:
    from google import genai

    api_key = load_api_key()
    client = genai.Client(api_key=api_key)

    image_bytes = image_path.read_bytes()
    b64 = base64.b64encode(image_bytes).decode()

    suffix = image_path.suffix.lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}.get(
        suffix.lstrip("."), "image/jpeg"
    )

    response = client.models.generate_content(
        model="gemini-3.8-flash",
        contents=[
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": mime, "data": b64}},
                    {"text": PROMPT},
                ],
            }
        ],
    )

    text = response.text.strip()
    # ```json ... ``` を剥がす
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    return json.loads(text.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="レシート画像のパス")
    args = ap.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        sys.exit(f"ファイルが無い: {image_path}")

    print(f"画像: {image_path}")
    print("Gemini に投げてる……")

    result = ocr_receipt(image_path)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print()
    print(f"店名: {result.get('store')}")
    print(f"日付: {result.get('date')}")
    print(f"品目数: {len(result.get('items', []))}")
    for i, item in enumerate(result.get("items", []), 1):
        print(f"  {i}. {item['name']}  {item['price']}円")
    print(f"合計: ¥{result.get('total')}")

    # 検証
    items = result.get("items", [])
    item_names = [it["name"] for it in items]
    if any("レジ袋" in n or "袋" == n for n in item_names):
        print("\n⚠ レジ袋が除外されてへん！")
    else:
        print("\n✓ レジ袋は除外されてる")

    if len(items) == 7:
        print("✓ 品目数 7（期待通り）")
    else:
        print(f"⚠ 品目数 {len(items)}（期待は 7）")


if __name__ == "__main__":
    # Windows ターミナルの文字化け対策
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    main()
