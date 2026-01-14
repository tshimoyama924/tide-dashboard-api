# Tide Dashboard API

釣行の意思決定支援を目的としたバックエンド API。
潮汐データ（気象庁）と天気予報（気象庁）を統合し、
Web / モバイル / 将来のアプリから共通利用できることを前提としている。

---

## 提供 API

### 港・釣り場マスター
GET /api/v1/stations  
登録されている港・釣り場マスターを返す。

---

### 潮汐
GET /api/v1/tides  
station_code と date (YYYY-MM-DD) を指定し、対象日の 24 時間潮位・満潮・干潮 を返す。

例:  
GET /api/v1/tides?station_code=CS&date=2026-01-15

---

### 天気コード
GET /api/v1/weather-codes  
weather_code.json の全件を返す（1日キャッシュ）。

GET /api/v1/weather-codes/{code}  
指定コードのみ返す。存在しない場合は 404。

404 時レスポンス:
{ "error": "weather_code_not_found", "code": "<code>" }

---

### 釣行予報（オーケストレータ API）
GET /api/v1/fishing-forecast  

潮汐・短期天気・週間天気を 1 リクエストで統合して返す。

例:  
GET /api/v1/fishing-forecast?station_code=CS&date=2026-01-15

返却内容:
- station（釣り場情報）
- 指定日の潮汐情報
- 当日の天気・風・波・降水確率
- 週間天気予報（7日分）

外部仕様の詳細は以下を参照:
docs/fishing-forecast-api-spec-v1.md

---

## 環境変数

以下のいずれかが必要:

- AZURE_STORAGE_CONNECTION_STRING
- STATIONS_CONNECTION_STRING
- AzureWebJobsStorage

読み取り対象 Blob:
- master/stations.json
- master/weather_code.json
- data/tide/{year}/{station}.json

---

## 潮汐データ更新手順（TXT → JSON → Blob）

1. 気象庁の固定長テキストを配置  
   data_raw/jma/2026_CS.txt  
   ※ data_raw は Git 管理対象外

2. 変換スクリプトを実行  
   npm run build  
   node scripts/convertTideTxtToJson.js --in ./data_raw/jma/2026_CS.txt --out ./data/tide/2026/CS.json --year 2026 --station_code CS

3. 生成された JSON を Azure Blob Storage にアップロード  
   パス: data/tide/2026/CS.json

4. API で確認  
   GET /api/v1/tides?station_code=CS&date=YYYY-MM-DD

---

## 開発メモ

- 潮汐 TXT の仕様は tide_txt_format_spec.md を参照
- convertTideTxtToJson:
  - 日付整合性
  - hourly 要素数（24件）
  を検証し、異常時はエラー終了
- GetTides:
  - stations.json による station_code 検証
  - 年別 JSON から対象日を抽出
  - データ不存在時は 404

---

## 位置づけ

本リポジトリは UI に依存しないバックエンド基盤であり、
釣り場ガイドサイト、ダッシュボード、将来のスマホアプリからの利用を想定している。
