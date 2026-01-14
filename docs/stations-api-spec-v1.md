# stations API 外部仕様（v1）

## 1. 概要
- 港マスタ情報を配列で返す読み取り専用 API。
- 釣り関連の他 API（tides / fishing-forecast など）が参照する共通マスタ。

## 2. エンドポイント
- `GET /api/v1/stations`
  - 認証: anonymous
  - キャッシュ: `Cache-Control: public, max-age=86400`、ETag による 304 応答あり

## 3. 入力
- クエリ・パスパラメータなし

## 4. 出力
- 200 OK 時は配列を返す。
```json
[
  {
    "station_code": "CS",
    "name": "銚子漁港",
    "office_code": "120000",
    "area_code": "120021",
    "area_name": "東部沿岸",
    "forecast_area_code": "120020"
  }
]
```
- フィールド
  - `station_code`: 2桁の港コード
  - `name`: 港名
  - `office_code`: JMA 都道府県予報区コード（週間予報などで使用）
  - `area_code`: JMA 短期予報のエリアコード
  - `area_name`: エリア表示名
  - `forecast_area_code`: 短期予報で area_code が存在しない場合に参照するフォールバックコード

## 5. エラー
- 500: マスタ読み込み失敗（Blob/ローカルともに取得不可）

## 6. 例
- リスト取得  
  `curl -i http://localhost:7071/api/v1/stations`
- ETag を用いた条件付き取得  
  `curl -i -H "If-None-Match: \"<ETag>\"" http://localhost:7071/api/v1/stations`

## 7. データソース・前提
- Blob: `master/stations.json`
- 返却内容は stations.json をそのまま配列で返す。
- ETag は Blob の ETag を使用。

## 8. バージョン
- v1: フィールドは `station_code, name, office_code, area_code, area_name, forecast_area_code` を提供。
