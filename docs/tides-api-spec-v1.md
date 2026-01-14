# tides API 外部仕様（v1）

## 1. 概要

指定日の潮汐情報（24時間潮位・満潮/干潮）を返す読み取り専用 API。
港マスタ（stations.json）で station_code を検証した上で、
年別潮汐 JSON から該当日のデータのみを抽出して返却する。

## 2. エンドポイント

GET /api/v1/tides

* 認証: anonymous
* キャッシュ:

  * Cache-Control: public, max-age=86400
  * ETag による 304 Not Modified 応答あり

## 3. 入力

### Query Parameters

* station_code (string, required)

  * stations.json に定義されたコードのみ許可
  * 英大文字推奨（例: CS）
* date (string, required)

  * 形式: YYYY-MM-DD

## 4. 出力

### 200 OK

```json
{
  "station_code": "CS",
  "date": "2026-01-01",
  "hourly": [123, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  "highTides": [
    { "time": "03:38", "heightCm": 115 }
  ],
  "lowTides": [
    { "time": "11:40", "heightCm": 15 }
  ],
  "meta": {
    "source": "JMA",
    "year": 2026,
    "dataVersion": "2026"
  }
}
```

## 5. フィールド定義

### hourly

* 0〜23時の潮位（cm）
* 必ず24要素
* 欠損値は null

### highTides / lowTides

* 満潮 / 干潮の配列
* フィールド:

  * time: "HH:MM"（24時間表記）
  * heightCm: number（cm）
* 該当がない場合は空配列

### meta

* source: "JMA" 固定
* year: number（対象年）
* dataVersion: string（例: "2026"）

## 6. エラー

### 400 Bad Request

* station_code 未指定 / 無効 / マスタ未定義
* date 未指定 / 形式不正

```json
{ "error": "date must be in YYYY-MM-DD format" }
```

### 404 Not Found

* 指定年の潮汐データが存在しない
* 指定日の潮汐データが存在しない

```json
{ "error": "Tide data not found for the specified date." }
```

### 500 Internal Server Error

* 内部処理エラー（Blob 読み込み失敗等）
* Cache-Control: no-store

## 7. データソース・前提

* 港マスタ:

  * Azure Blob Storage: master/stations.json
* 潮汐データ:

  * Azure Blob Storage: data/tide/{year}/{station_code}.json
* ETag:

  * 年別潮汐 JSON Blob の ETag を使用
* メモリキャッシュ（実装依存）:

  * TTL 約5分

## 8. バージョン

* v1:

  * station_code と date を受け取り、
    指定日の潮汐情報と JMA メタ情報を返却する。
