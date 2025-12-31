tide_txt_format_spec (JMA tide TXT)
====================================

Source of truth: https://www.data.jma.go.jp/kaiyou/db/tide/suisan/readme.html

Line structure (fixed columns, 1-based):
- Columns 1-72   : Hourly tide heights (24 values, 3 chars each, signed int). Missing = `999` -> JSON null.
- Columns 73-78  : Date field = `YY` + month/day with spaces (examples: `26 1 1`, `2610 1`, `261231`).
- Columns 79-80  : Station code (2 chars).
- Columns 81-108 : High tides, 4 blocks of 7 chars `[time4][height3]`.
- Columns 109-136: Low tides, 4 blocks of 7 chars `[time4][height3]`.

Event block rules:
- `time4`: trim -> padStart(4, "0") -> HHMM. Skip if empty or `9999`. Invalid if HH>23 or MM>59.
- `height3`: trim, allow sign, parseInt. Skip if empty or `999`.
- From each segment (high/low), take the first 2 valid events in order. If none, return [].

Date parsing (columns 73-78):
- YY = first 2 chars -> year = 2000 + YY (must match target year).
- Remainder after YY, trimmed:
  - If contains spaces: split into month, day.
  - If no spaces and length=4: MMDD.
  - If no spaces and length=3: MDD (e.g., `110` => Jan 10).
- Month 1-12, day 1-31 required.

Hourly parsing:
- 24 segments of width 3 from columns 1-72.
- `999` or blank => null. Otherwise signed integer.

Conversion script (fixed-column only):
- `scripts/convertTideTxtToJson.ts`
- Per line:
  - hourly = slice(0,72)
  - date  = slice(72,78) -> year/month/day
  - station = slice(78,80)
  - high segment = slice(80,108), low segment = slice(108,136)
  - events parsed in 7-char blocks with the above rules.

Validation script:
- `scripts/validateTideJsonAgainstTxt.ts`
- Re-parses TXT with the same fixed-column rules and compares to JSON.

Run examples (after `npm run build`):
- Convert all: `node dist/scripts/convertTideTxtToJson.js`
- Validate:    `node dist/scripts/validateTideJsonAgainstTxt.js --year 2026`
