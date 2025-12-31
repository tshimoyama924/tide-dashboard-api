/**
 * Convert JMA fixed-width tide text into JSON.
 *
 * Assumptions (see tide_txt_format_spec.md for details):
 * - 24 hourly tide heights at the head of each line, width 3 (signed, 999 => missing).
 * - After hourly: YY SP M SP D STATION SP tide event payload.
 * - Tide events are parsed as sequential (time4 + height3) pairs; first two = high, next two = low.
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
    meta?: { source?: string; dataVersion?: string | number };
};

type CliArgs =
    | {
          mode: "single";
          in: string;
          out: string;
          year: number;
          station_code: string;
      }
    | {
          mode: "all";
      };

const HOURS_WIDTH = 3;
const HOURS_COUNT = 24;
const YEAR_BASE = 2000;

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        // No parameters: process all txt in data_raw/jma -> data/tide/{year}/{station}.json
        return { mode: "all" };
    }
    const get = (key: string) => {
        const idx = args.indexOf(`--${key}`);
        return idx >= 0 ? args[idx + 1] : undefined;
    };
    const input = get("in");
    const output = get("out");
    const yearStr = get("year");
    const station = get("station_code");

    if (!input || !output || !yearStr || !station) {
        throw new Error("Usage: node scripts/convertTideTxtToJson.js --in <file> --out <file> --year <YYYY> --station_code <CODE>");
    }
    const year = Number(yearStr);
    if (!Number.isInteger(year) || year < 1900) {
        throw new Error("year must be a valid integer (YYYY).");
    }
    return { mode: "single", in: input, out: output, year, station_code: station.toUpperCase() };
}

function parseHourly(hourlyRaw: string): Array<number | null> {
    if (hourlyRaw.length < HOURS_WIDTH * HOURS_COUNT) {
        throw new Error(`Hourly section too short (${hourlyRaw.length}).`);
    }
    const values: Array<number | null> = [];
    for (let i = 0; i < HOURS_COUNT; i++) {
        const segment = hourlyRaw.slice(i * HOURS_WIDTH, (i + 1) * HOURS_WIDTH);
        const trimmed = segment.trim();
        const normalized = trimmed.replace(/\s+/g, "");
        if (!normalized || normalized === "999") {
            values.push(null);
            continue;
        }
        const val = Number(normalized);
        if (Number.isNaN(val)) {
            throw new Error(`Invalid hourly value '${segment}' at hour ${i}`);
        }
        values.push(val);
    }
    return values;
}

function parseMetaAndPayload(payload: string, expectedStation: string, expectedYear: number) {
    const trimmed = payload.trim();
    let stationIndex = trimmed.toUpperCase().indexOf(expectedStation.toUpperCase());
    if (stationIndex < 0) {
        // Some files might have wrong station token; attempt last 2 letters as fallback (e.g., '1D2' instead of 'D3')
        stationIndex = trimmed.length - 2;
        expectedStation = trimmed.slice(stationIndex).trim().toUpperCase();
    }
    const idx = stationIndex;
    if (idx < 0) {
        throw new Error(`Station ${expectedStation} not found in meta '${payload}'`);
    }

    const head = trimmed.slice(0, idx).trim();
    const rest = trimmed.slice(idx + expectedStation.length).trim();

    const digitsOnly = head.replace(/\s+/g, "");
    if (digitsOnly.length < 2) {
        throw new Error(`No year/month/day digits found in '${payload}'`);
    }
    const yy = digitsOnly.slice(0, 2);
    const digitsNoYear = digitsOnly.slice(2);

    const year = YEAR_BASE + Number(yy);
    if (year !== expectedYear) {
        // Allow but warn; downstream validation will catch inconsistencies.
    }

    let month: number;
    let day: number;
    if (!digitsNoYear && head.trim() === "") {
        // fallback: month/day maybe absent in head; try reading from rest prefix (e.g., "1 1D1 ...")
        const m = restPrefixFromPayload(trimmed, expectedStation);
        month = m.month;
        day = m.day;
    } else {
        const res = splitMonthDay(digitsNoYear);
        month = res.month;
        day = res.day;
    }
    if (!month || month > 12 || !day || day > 31) {
        throw new Error(`Invalid date fields month=${month} day=${day}`);
    }

    return { year, month, day, station: expectedStation, rest };
}

function restPrefixFromPayload(payload: string, expectedStation: string): { month: number; day: number } {
    // Example: "1 1D1 338115..." => tokens before station: "1", "1D1"
    const tokens = payload.split(/\s+/).filter((t) => t.length > 0);
    for (const token of tokens) {
        if (token.toUpperCase().includes(expectedStation.toUpperCase())) {
            const parts = token.split(expectedStation);
            const digits = parts[0] || "";
            return splitMonthDay(digits);
        }
    }
    throw new Error(`Cannot extract month/day from '${payload}'`);
}

function splitMonthDay(digits: string): { month: number; day: number } {
    const candidates: Array<{ month: number; day: number }> = [];
    const tryAdd = (mStr: string, dStr: string) => {
        if (!mStr || !dStr) return;
        const m = Number(mStr);
        const d = Number(dStr);
        if (!Number.isNaN(m) && !Number.isNaN(d)) {
            candidates.push({ month: m, day: d });
        }
    };

    // Try month length 2 then 1 (prefer valid ranges)
    if (digits.length >= 2) {
        if (digits.length >= 3) {
            tryAdd(digits.slice(0, 2), digits.slice(2));
        }
        tryAdd(digits.slice(0, 1), digits.slice(1));
    } else if (digits.length === 1) {
        tryAdd(digits.slice(0, 1), "1"); // fallback impossible case
    }

    for (const c of candidates) {
        if (c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31) {
            return c;
        }
    }
    throw new Error(`Cannot split month/day from '${digits}'`);
}

function chunkEvents(compact: string): TideEvent[] {
    // Drop leading count digit if present (e.g., "4...")
    if (/^\d$/.test(compact[0])) {
        compact = compact.slice(1);
    }
    const events: TideEvent[] = [];
    let cursor = 0;
    while (cursor + 4 <= compact.length) {
        const timeStr = compact.slice(cursor, cursor + 4);
        cursor += 4;

        if (cursor >= compact.length) break;
        let heightSign = "";
        if (compact[cursor] === "-" || compact[cursor] === "+") {
            heightSign = compact[cursor];
            cursor += 1;
        }
        const heightDigits = compact.slice(cursor, cursor + 3);
        cursor += 3;

        const timeNum = Number(timeStr);
        const heightNum = Number(heightSign + heightDigits);

        if (timeStr === "9999" || Number.isNaN(timeNum) || timeNum < 0) {
            continue;
        }
        if (heightDigits === "999" || Number.isNaN(heightNum)) {
            continue;
        }

        const hh = String(Math.floor(timeNum / 100)).padStart(2, "0");
        const mm = String(timeNum % 100).padStart(2, "0");
        events.push({ time: `${hh}:${mm}`, heightCm: heightNum });
    }
    return events;
}

function splitEvents(rest: string) {
    // Remove spaces and parse sequential time/height pairs.
    const compact = rest.replace(/\s+/g, "");
    const events = chunkEvents(compact);
    const highTides = events.slice(0, 2);
    const lowTides = events.slice(2, 4);
    return { highTides, lowTides };
}

function parseLine(line: string, expectedYear: number, expectedStation: string): { date: string; day: TideDay } {
    const hourlyRaw = line.slice(0, HOURS_WIDTH * HOURS_COUNT);
    const hourly = parseHourly(hourlyRaw);

    const metaPayload = line.slice(HOURS_WIDTH * HOURS_COUNT).trim();
    const { year, month, day, station, rest } = parseMetaAndPayload(metaPayload, expectedStation, expectedYear);

    if (year !== expectedYear) {
        throw new Error(`Year mismatch in line: ${year} (expected ${expectedYear})`);
    }
    if (station !== expectedStation) {
        throw new Error(`Station mismatch in line: ${station} (expected ${expectedStation})`);
    }

    const { highTides, lowTides } = splitEvents(rest);
    const date = `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    return {
        date,
        day: {
            hourly,
            highTides,
            lowTides,
        },
    };
}

async function main() {
    const args = parseArgs();
    if (args.mode === "single") {
        await convertOne(args.in, args.out, args.year, args.station_code);
        return;
    }

    // mode === "all": discover files in data_raw/jma/*.txt
    const rawBase = path.join(process.cwd(), "data_raw", "jma");
    const outBase = path.join(process.cwd(), "data", "tide");
    const entries = await fs.promises.readdir(rawBase, { withFileTypes: true });

    const tasks: Array<{ in: string; out: string; year: number; station: string }> = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue;
        const m = entry.name.match(/^(\d{4})_([A-Za-z0-9]{2})\.txt$/);
        if (!m) {
            // eslint-disable-next-line no-console
            console.warn(`Skipping unexpected file name: ${entry.name}`);
            continue;
        }
        const year = Number(m[1]);
        const station = m[2].toUpperCase();
        const inPath = path.join(rawBase, entry.name);
        const outPath = path.join(outBase, m[1], `${station}.json`);
        tasks.push({ in: inPath, out: outPath, year, station });
    }

    if (tasks.length === 0) {
        throw new Error(`No txt files found under ${rawBase}`);
    }

    const results: string[] = [];
    for (const t of tasks) {
        try {
            await convertOne(t.in, t.out, t.year, t.station);
            results.push(`OK ${t.in} -> ${t.out}`);
        } catch (err) {
            results.push(`NG ${t.in}: ${err instanceof Error ? err.message : err}`);
        }
    }

    // eslint-disable-next-line no-console
    console.log(results.join("\n"));
}

async function convertOne(input: string, output: string, year: number, stationCode: string) {
    const raw = await fs.promises.readFile(input, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
        throw new Error("Input file is empty.");
    }

    const days: Record<string, TideDay> = {};
    for (const line of lines) {
        const { date, day } = parseLine(line, year, stationCode);
        if (day.hourly.length !== HOURS_COUNT) {
            throw new Error(`Hourly count is not 24 for date ${date}`);
        }
        days[date] = day;
    }

    const outDir = path.dirname(output);
    await fs.promises.mkdir(outDir, { recursive: true });

    const tideYear: TideYear = {
        station_code: stationCode,
        year,
        days,
        meta: { source: "JMA", dataVersion: year },
    };

    await fs.promises.writeFile(output, JSON.stringify(tideYear, null, 2), "utf-8");
    // eslint-disable-next-line no-console
    console.log(`Wrote ${Object.keys(days).length} days to ${output}`);
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
