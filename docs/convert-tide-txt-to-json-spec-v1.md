# convertTideTxtToJson CLI 外部仕様（v1）

## 1. 概要
- 気象庁の固定長潮汐 TXT（1年分）を年別 JSON に変換する CLI ツール。
- 生成した JSON を Azure Blob `data/tide/{year}/{station}.json` にアップロードする前処理として利用。

## 2. コマンド
- ビルド前: `node scripts/convertTideTxtToJson.ts`
- ビルド後: `node dist/scripts/convertTideTxtToJson.js`

## 3. 入力（引数）
- `--in` (string, required): 入力TXTパス。例 `./data_raw/jma/2026_CS.txt`
- `--out` (string, required): 出力JSONパス。例 `./data/tide/2026/CS.json`
- `--year` (number, required): 西暦4桁。例 `2026`
- `--station_code` (string, required): 駅コード（2文字）。例 `CS`

制約:
- TXTは気象庁配布の固定長フォーマット。`tide_txt_format_spec.md` に準拠。
- 入力パス `data_raw/jma/` は Git 管理外を想定。

## 4. 出力
- JSONファイル: `data/tide/{year}/{station}.json`
  - `hourly` 24要素/日、欠損は null
  - `highTides` / `lowTides`: time `"HH:MM"`, heightCm (number)
  - `days` に日付キー `"YYYY-MM-DD"`
  - `meta` に `source: "JMA"`, `dataVersion: year`

## 5. エラー
- 引数不足や year/駅コード不正で即時エラー終了
- 日付整合性や hourly の要素数が 24 でない場合はエラー終了
- 入力ファイルなし/読込不可でエラー終了

## 6. 例
- 1行実行例  
  `node dist/scripts/convertTideTxtToJson.js --in ./data_raw/jma/2026_CS.txt --out ./data/tide/2026/CS.json --year 2026 --station_code CS`

- PowerShell (行継続)  
  ```powershell
  node dist/scripts/convertTideTxtToJson.js ^
    --in ./data_raw/jma/2026_CS.txt ^
    --out ./data/tide/2026/CS.json ^
    --year 2026 ^
    --station_code CS
  ```

## 7. データソース・前提
- 入力: 気象庁潮汐TXT (固定長)。`data_raw/jma/{year}_{station}.txt`
- 出力: `data/tide/{year}/{station}.json`
- アップロード先: Azure Blob `data` コンテナ配下 `tide/{year}/{station}.json`
- 変換仕様: `tide_txt_format_spec.md` を参照

## 8. バージョン
- v1: TXT→JSON 変換、日付整合性/24h検証、シンプルな CLI 引数のみを提供。***
