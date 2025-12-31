/**
 * Validate generated tide JSON against JMA fixed-width tide TXT.
 *
 * Source of truth: JMA fixed column definition
 * - 1 line = 1 day
 * - Hourly: columns 1-72 (3 chars x 24). Missing: 999 -> null
 * - Date: columns 73-78 : "YY + variable M/D with spaces" (e.g., "26 1 1", "2610 1", "261231")
 * - Station: columns 79-80 (2 chars)
 * - High tide events: columns 81-108 (28 chars = 7 chars x 4 blocks)
 * - Low tide events : columns 109-136 (28 chars = 7 chars x 4 blocks)
 * - Event block: time4 (HHMM, may be space-padded like " 338") + height3 (may include sign, e.g., " -3")
 *   Missing: time==9999 or height==999 -> ignore that event
 *   Adopt: first 2 valid events for high, first 2 valid events for low
 *
 * Exit code:
 * - 0 if all OK
 * - 1 if any diff found
 */

import * as fs from "node:fs";
import * as path from "node:path";

type TideEvent = { time: string; heightCm: number };
type TideDay = {
  hourly: Array<number | null>;
  highTides: TideEvent[];
  lowTides: TideEvent[];
};
type TideYear = {
  station_code: string;
  year: number;
  days: Record<string, TideDay>;
  meta?: unknown;
};

const HOURS_COUNT = 24;
const HOURS_WIDTH = 3;
const YEAR_BASE = 2000;

// 0-based slice indices (end exclusive)
const IDX_HOURLY_START = 0;
const IDX_HOURLY_END = 72; // 24*3
const IDX_DATE_START = 72; // col73
const IDX_DATE_END = 78;   // col78 end exclusive
const IDX_STATION_START = 78; // col79
const IDX_STATION_END = 80;   // col80 end exclusive
const IDX_HIGH_START = 80; // col81
const IDX_HIGH_END = 108;  // col108 end exclusive
const IDX_LOW_START = 108; // col109
const IDX_LOW_END = 136;   // col136 end exclusive

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const idx = args.indexOf(`--${key}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const yearStr = get("year");
  if (!yearStr) throw new Error("Usage: node dist/scripts/validateTideJsonAgainstTxt.js --year <YYYY>");
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 1900) throw new Error("Invalid --year");
  return { year };
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function parseHourlyFromLine(line: string): Array<number | null> {
  const raw = line.slice(IDX_HOURLY_START, IDX_HOURLY_END);
  if (raw.length < IDX_HOURLY_END) throw new Error(`Line too short for hourly: len=${line.length}`);

  const out: Array<number | null> = [];
  for (let i = 0; i < HOURS_COUNT; i++) {
    const seg = raw.slice(i * HOURS_WIDTH, (i + 1) * HOURS_WIDTH);
    const t = seg.trim();
    if (!t || t === "999") {
      out.push(null);
      continue;
    }
    // allow signed
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error(`Invalid hourly '${seg}' at hour ${i}`);
    out.push(n);
  }
  if (out.length !== 24) throw new Error("Hourly parse did not return 24 elements");
  return out;
}

function parseDateFromFixedField(field73_78: string, expectedYear: number): { year: number; month: number; day: number; dateKey: string } {
  // field is 6 chars, but may include spaces like "26 1 1"
  // Strategy:
  // 1) keep as-is, rstrip only
  // 2) YY = first 2 chars (digits)
  // 3) rest = remaining 4 chars, trim
  //    - if contains spaces -> split => M, D
  //    - else => MMDD (2+2)
  const d = field73_78.replace(/\s+$/g, ""); // rstrip
  if (d.length < 2) throw new Error(`Invalid date field '${field73_78}'`);

  const yyStr = d.slice(0, 2);
  const yy = Number(yyStr);
  if (!Number.isInteger(yy)) throw new Error(`Invalid YY '${yyStr}' from '${field73_78}'`);

  const year = YEAR_BASE + yy;
  // expectedYear is provided by file name / JSON
  if (year !== expectedYear) {
    throw new Error(`Year mismatch in date field: parsed=${year} expected=${expectedYear} raw='${field73_78}'`);
  }

  const rest = d.slice(2).trim(); // may be "1 1" or "10 1" or "1231"
  if (!rest) throw new Error(`Empty month/day in '${field73_78}'`);

  let month: number;
  let day: number;

  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 2) {
    month = Number(parts[0]);
    day = Number(parts[1]);
  } else if (parts.length === 1) {
    const md = parts[0];
    if (md.length === 4) {
      month = Number(md.slice(0, 2));
      day = Number(md.slice(2, 4));
    } else if (md.length === 3) {
      month = Number(md.slice(0, 1));
      day = Number(md.slice(1, 3));
    } else {
      throw new Error(`Expected MDD or MMDD but got '${md}' from '${field73_78}'`);
    }
  } else {
    throw new Error(`Cannot parse month/day from '${field73_78}'`);
  }

  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
    throw new Error(`Invalid month/day parsed from '${field73_78}': ${month}/${day}`);
  }

  const dateKey = `${year}-${pad2(month)}-${pad2(day)}`;
  return { year, month, day, dateKey };
}

function parseEventsFromFixedSegment(segment: string): TideEvent[] {
  // segment length is expected 28, but we accept >= 7 and parse by 7-char blocks
  const out: TideEvent[] = [];
  const usable = segment.length - (segment.length % 7);
  const s = segment.slice(0, usable);

  for (let i = 0; i + 7 <= s.length; i += 7) {
    const blk = s.slice(i, i + 7);
    const timeRaw = blk.slice(0, 4);
    const heightRaw = blk.slice(4, 7);

    let t = timeRaw.trim();
    if (!t) continue;
    if (t === "9999") continue;
    t = t.padStart(4, "0"); // " 338" -> "0338"
    const hh = Number(t.slice(0, 2));
    const mm = Number(t.slice(2, 4));
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      continue;
    }

    const hStr = heightRaw.trim();
    if (!hStr) continue;
    if (hStr === "999") continue;
    const h = Number(hStr);
    if (Number.isNaN(h)) continue;

    out.push({ time: `${pad2(hh)}:${pad2(mm)}`, heightCm: h });
  }

  return out;
}

function expectedDayFromLine(line: string, expectedYear: number): { station: string; dateKey: string; day: TideDay } {
  if (line.length < IDX_LOW_END) {
    // Some lines might be shorter due to trailing spaces being stripped by tools.
    // We can right-pad to make fixed slices safe.
    line = line.padEnd(IDX_LOW_END, " ");
  }

  const hourly = parseHourlyFromLine(line);

  const dateField = line.slice(IDX_DATE_START, IDX_DATE_END);
  const { dateKey } = parseDateFromFixedField(dateField, expectedYear);

  const station = line.slice(IDX_STATION_START, IDX_STATION_END).trim().toUpperCase();
  if (station.length !== 2) {
    throw new Error(`Invalid station field '${line.slice(IDX_STATION_START, IDX_STATION_END)}'`);
  }

  const highSeg = line.slice(IDX_HIGH_START, IDX_HIGH_END);
  const lowSeg = line.slice(IDX_LOW_START, IDX_LOW_END);

  const high = parseEventsFromFixedSegment(highSeg).slice(0, 2);
  const low = parseEventsFromFixedSegment(lowSeg).slice(0, 2);

  return {
    station,
    dateKey,
    day: { hourly, highTides: high, lowTides: low },
  };
}

function diffArray<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return true;
  }
  return false;
}

function loadStationCodes(): string[] {
  // Resolve from project root (works for src/ and dist/ execution)
  const p = path.join(process.cwd(), "stations.json");
  if (!fs.existsSync(p)) {
    throw new Error(`stations.json not found at ${p}`);
  }
  const arr = readJson<Array<{ station_code: string }>>(p);
  return arr.map((x) => x.station_code.toUpperCase()).sort();
}



function validateStation(year: number, station: string): string[] {
  const diffs: string[] = [];

  const txtPath = path.join(process.cwd(), "data_raw", "jma", `${year}_${station}.txt`);
  const jsonPath = path.join(process.cwd(), "data", "tide", String(year), `${station}.json`);

  if (!fs.existsSync(txtPath)) {
    diffs.push(`[${station}] missing TXT: ${txtPath}`);
    return diffs;
  }
  if (!fs.existsSync(jsonPath)) {
    diffs.push(`[${station}] missing JSON: ${jsonPath}`);
    return diffs;
  }

  const json = readJson<TideYear>(jsonPath);
  if (json.year !== year) diffs.push(`[${station}] JSON.year mismatch: ${json.year} != ${year}`);
  if (json.station_code.toUpperCase() !== station) diffs.push(`[${station}] JSON.station_code mismatch: ${json.station_code} != ${station}`);
  if (!json.days || typeof json.days !== "object") diffs.push(`[${station}] JSON.days missing/invalid`);

  const raw = fs.readFileSync(txtPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const expectedDates: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    let exp;
    try {
      exp = expectedDayFromLine(line, year);
    } catch (e) {
      diffs.push(`[${station}] TXT parse error at line ${idx + 1}: ${(e as Error).message}`);
      continue;
    }

    if (exp.station !== station) {
      diffs.push(`[${station}] station mismatch at line ${idx + 1}: parsed=${exp.station} expected=${station}`);
      continue;
    }

    expectedDates.push(exp.dateKey);

    const actual = json.days?.[exp.dateKey];
    if (!actual) {
      diffs.push(`[${station}] missing day in JSON: ${exp.dateKey}`);
      continue;
    }

    // hourly
    if (!Array.isArray(actual.hourly) || actual.hourly.length !== 24) {
      diffs.push(`[${station}] hourly length invalid: ${exp.dateKey} len=${actual.hourly?.length}`);
    } else if (diffArray(actual.hourly, exp.day.hourly)) {
      diffs.push(`[${station}] hourly mismatch: ${exp.dateKey}`);
    }

    // events (high/low)
    const aHigh = Array.isArray(actual.highTides) ? actual.highTides : [];
    const aLow = Array.isArray(actual.lowTides) ? actual.lowTides : [];
    if (diffArray(aHigh, exp.day.highTides)) {
      diffs.push(
        `[${station}] highTides mismatch: ${exp.dateKey}\n  expected=${JSON.stringify(exp.day.highTides)}\n  actual  =${JSON.stringify(aHigh)}`
      );
    }
    if (diffArray(aLow, exp.day.lowTides)) {
      diffs.push(
        `[${station}] lowTides mismatch: ${exp.dateKey}\n  expected=${JSON.stringify(exp.day.lowTides)}\n  actual  =${JSON.stringify(aLow)}`
      );
    }
  }

  // Extra dates in JSON
  if (json.days) {
    const jsonDates = Object.keys(json.days);
    const expSet = new Set(expectedDates);
    for (const d of jsonDates) {
      if (!expSet.has(d)) {
        diffs.push(`[${station}] extra day in JSON (not in TXT): ${d}`);
      }
    }
  }

  return diffs;
}

function main() {
  const { year } = parseArgs();
  const stationCodes = loadStationCodes();

  const allDiffs: string[] = [];
  for (const station of stationCodes) {
    const diffs = validateStation(year, station);
    allDiffs.push(...diffs);
    // eslint-disable-next-line no-console
    console.log(`${station}: ${diffs.length === 0 ? "OK" : `NG(${diffs.length})`}`);
  }

  if (allDiffs.length > 0) {
    // eslint-disable-next-line no-console
    console.error("\n=== DIFFS ===");
    // 大量になるので最初の200件だけ表示。増やしたければ調整。
    for (const d of allDiffs.slice(0, 200)) {
      // eslint-disable-next-line no-console
      console.error(d);
    }
    // eslint-disable-next-line no-console
    console.error(`\nTotal diffs: ${allDiffs.length}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("ALL OK");
}

main();
