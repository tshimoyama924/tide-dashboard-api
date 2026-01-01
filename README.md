## Tide Dashboard API

### 追加した API
- `GET /api/v1/stations` : 港マスターを返す
- `GET /api/v1/tides` : station_code と date (YYYY-MM-DD) を指定して 24 時間の潮位と高低潮を返す
- `GET /api/v1/weather-codes` : weather_code.json の全件を返す（1日キャッシュ）
- `GET /api/v1/weather-codes/{code}` : 指定コードのみ返す。なければ 404 で `{"error":"weather_code_not_found","code":"<code>"}` を返却

### 環境変数
- `AZURE_STORAGE_CONNECTION_STRING` または既存の `STATIONS_CONNECTION_STRING` / `AzureWebJobsStorage`  
  読み取り対象: `master/stations.json` / `master/weather_code.json` / `data/tide/{year}/{station}.json`

### 潮汐データの更新手順（TXT → JSON → Blob）
1. 気象庁の固定長テキストを `data_raw/jma/` 配下に配置（例: `data_raw/jma/2026_CS.txt`）。`data_raw/` は Git 管理対象外。
2. 変換スクリプトを実行して年別 JSON を生成。
   ```powershell
   npm run build
   node scripts/convertTideTxtToJson.js ^
     --in ./data_raw/jma/2026_CS.txt ^
     --out ./data/tide/2026/CS.json ^
     --year 2026 ^
     --station_code CS
   ```
3. 生成された `data/tide/{year}/{station}.json` を Azure Blob Storage の `data` コンテナーにアップロード（パス: `tide/{year}/{station}.json`）。
4. Function App から `/api/v1/tides?station_code=CS&date=YYYY-MM-DD` で確認。

### weather-codes API テスト例
- `curl http://localhost:7071/api/v1/weather-codes`
- `curl http://localhost:7071/api/v1/weather-codes/201`

### 開発メモ
- 変換仕様は `tide_txt_format_spec.md` を参照。
- `scripts/convertTideTxtToJson.ts` は in/out/year/station_code を受け取り、日付整合性と hourly 要素数を検証。異常時はエラー終了。
- `GetTides.ts` は `master/stations.json` で station_code を検証し、`data/tide/{year}/{station}.json` から該当日だけ返却する（無ければ 404）。
