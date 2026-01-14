# fishing-forecast API 外部仕様（v1）

## 1. 概要

`fishing-forecast` API は、**釣行の意思決定支援**を目的としたオーケストレータ API である。

以下の情報を **1リクエスト** で統合して返却する。

- 釣り場（station）情報
- 指定日の潮汐情報（潮位・満潮・干潮）
- 指定日の短期天気予報（天気・風・波・降水確率）
- 週間天気予報（7日分）

バックエンドと UI を分離する前提で設計されており、Web / モバイル / アプリで共通利用できる。

---

## 2. エンドポイント

```
GET /api/v1/fishing-forecast
```

### クエリパラメータ

| 名前 | 型 | 必須 | 説明 |
|---|---|---|---|
| station_code | string | ✓ | 釣り場コード（例: CS, TK） |
| date | string (YYYY-MM-DD) | ✓ | 取得対象日 |

### リクエスト例

```
GET /api/v1/fishing-forecast?station_code=CS&date=2026-01-15
```

---

## 3. データソース

| 種別 | ソース |
|---|---|
| 釣り場マスタ | Blob Storage（stations.json） |
| 潮汐 | 自前 Tide API（JMA 原データ） |
| 天気予報 | 気象庁（JMA） forecast API |
| 天気コード | 自前 weather-codes API（任意） |

---

## 4. エリア解決ロジック（重要）

### 4.1 station のエリア属性

stations.json には以下の情報を持つ。

- `area_code`：行政・地域区分（例: 香取・海匝 = 120021）
- `forecast_area_code`：JMA 天気予報取得用エリアコード（例: 北東部 = 120020）

```json
{
  "station_code": "CS",
  "area_code": "120021",
  "forecast_area_code": "120020"
}
```

### 4.2 JMA API との対応関係

JMA の天気予報 API では、**必ずしも細分化された area_code が返却されない**。

例：千葉県（120000）

| 分類 | JMA短期予報で出現 |
|---|---|
| 120010 北西部 | ✓ |
| 120020 北東部 | ✓ |
| 120030 南部 | ✓ |
| 120021 香取・海匝 | ✗ |

そのため、**stations.json 側で「代表となる forecast_area_code」を明示的に定義**する。

### 4.3 解決ルール

1. `forecast_area_code` が存在する場合
   - それを用いて short forecast（天気・風・波・降水確率）を取得

2. `forecast_area_code` が null の場合
   - `area_code` を直接使用

使用したコードはレスポンス `meta` に記録される。

---

## 5. レスポンス仕様

### 5.1 全体構造

```json
{
  "station": {...},
  "date": "YYYY-MM-DD",
  "tide": {...},
  "today": {...},
  "weekly": [...],
  "meta": {...}
}
```

---

### 5.2 station

```json
"station": {
  "station_code": "CS",
  "name": "銚子漁港",
  "office_code": "120000",
  "area_code": "120021",
  "area_name": "香取・海匝",
  "forecast_area_code": "120020"
}
```

---

### 5.3 tide

```json
"tide": {
  "hourly_cm": [74, 89, 101, ...],
  "high": [
    { "time": "04:10", "height_cm": 112 },
    { "time": "12:20", "height_cm": 125 }
  ],
  "low": [
    { "time": "07:10", "height_cm": 107 },
    { "time": "20:41", "height_cm": 22 }
  ],
  "meta": {
    "source": "JMA",
    "year": 2026,
    "dataVersion": "2026"
  }
}
```

---

### 5.4 today（短期予報）

```json
"today": {
  "weather": {
    "code": "211",
    "text_ja": "くもり昼過ぎから晴れ",
    "icon": "211.svg"
  },
  "wind_text": "北西の風後南西の風やや強い海上では南西の風強い",
  "wave_text": "２メートル後３メートルうねりを伴う",
  "pop": [
    { "time": "00:00", "value": 0 },
    { "time": "06:00", "value": 10 },
    { "time": "12:00", "value": 0 },
    { "time": "18:00", "value": 0 }
  ]
}
```

※ 対象日が forecast 初日でない場合、値が null になることがある（JMA仕様）。

---

### 5.5 weekly（週間予報）

```json
"weekly": [
  {
    "date": "2026-01-17",
    "weather": { "code": "201", "icon": "201.svg" },
    "pop": 30,
    "temp_min": 6,
    "temp_max": 15,
    "reliability": "A"
  }
]
```

---

### 5.6 meta

```json
"meta": {
  "forecast_source": "JMA",
  "forecast_report_datetime": "2026-01-14T17:00:00+09:00",
  "weekly_temp_area": {
    "name": "銚子",
    "code": "45148"
  },
  "used_area_code": "120020",
  "used_pop_area_code": "120020"
}
```

---

## 6. 設計上の注意点

- `null` は **データ欠損ではなく JMA 提供仕様による未提供** を意味する
- API は「欠けた情報を補完しない」方針（UI 側で表現制御）
- 週間・短期の境界日は JMA の構造に依存

---

## 7. 想定ユースケース

- 釣行前日の可否判断
- 潮位×風×波の同時確認
- UI ダッシュボード / モバイルアプリ / 将来のネイティブアプリ

---

## 8. バージョン

- v1：潮汐＋短期天気＋週間天気の統合（2026-01）

---

以上

