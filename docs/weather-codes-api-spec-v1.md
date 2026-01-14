# weather-codes API 外部仕様（v1）

## 1. 概要
- 気象庁の天気コードマスタを返す読み取り専用 API。
- 全件取得とコード指定の2種類を提供。

## 2. エンドポイント
- `GET /api/v1/weather-codes`
- `GET /api/v1/weather-codes/{code}`
  - 認証: anonymous
  - キャッシュ: `Cache-Control: public, max-age=86400`、ETag による 304 応答あり

## 3. 入力
- Path
  - `code` (string, optional): 例 `201`。指定しない場合は全件返却。
- Query: なし

## 4. 出力
- 全件 (200)
```json
{
  "100": { "icon_day": "100.svg", "icon_night": "500.svg", "group": "100", "ja": "晴", "en": "CLEAR" },
  "201": { "icon_day": "201.svg", "icon_night": "601.svg", "group": "200", "ja": "曇り時々晴れ", "en": "MOSTLY CLOUDY" }
}
```
- 単体 (200)
```json
{ "code": "201", "icon_day": "201.svg", "icon_night": "601.svg", "group": "200", "ja": "...", "en": "..." }
```
- フィールド
  - `code`: パス指定したコード（単体時のみ付与）
  - `icon_day` / `icon_night`: アイコンファイル名
  - `group`: グループコード
  - `ja` / `en`: 天気文言

## 5. エラー
- 404: コード未定義（detail のみ）  
  `{ "error": "weather_code_not_found", "code": "<code>" }`
- 500: マスタ読み込み失敗  
  `Cache-Control: no-store`

## 6. 例
- 全件  
  `curl http://localhost:7071/api/v1/weather-codes`
- 単体  
  `curl http://localhost:7071/api/v1/weather-codes/201`
- 条件付き（ETag）  
  `curl -i -H "If-None-Match: \"<ETag>\"" http://localhost:7071/api/v1/weather-codes`

## 7. データソース・前提
- Blob: `master/weather_code.json`
- 全件/単件とも同じ Blob を参照。ETag は Blob の ETag を使用。

## 8. バージョン
- v1: 全件・単件取得を提供し、コード未定義時は 404 を返す。*** End Patch*** End Patch. Need fix trailing text to proper patch. Use apply_patch again. }**
