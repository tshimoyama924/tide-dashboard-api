/**
 * Convert JMA fixed-width tide text into JSON (strict fixed-column parsing).
 *
 * Column definition (1-based, from JMA):
 * - Hourly: 1-72 (3 chars x 24, signed, 999 => missing)
 * - Date : 73-78 (YY + variable M/D with spaces)
 * - Station: 79-80 (2 chars)
 * - High tides: 81-108 (4 blocks of [time4][height3])
 * - Low  tides: 109-136 (4 blocks of [time4][height3])
 *
 * This parser uses only fixed slices; no searching/trimming-based detection.
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

// Fixed slice indices (0-based, end exclusive)
const IDX_HOURLY_START = 0;
const IDX_HOURLY_END = 72;
const IDX_DATE_START = 72; // col73
const IDX_DATE_END = 78; // col78
const IDX_STATION_START = 78; // col79
const IDX_STATION_END = 80; // col80
const IDX_HIGH_START = 80; // col81
const IDX_HIGH_END = 108; // col108
const IDX_LOW_START = 108; // col109
const IDX_LOW_END = 136; // col136

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
        if (!trimmed || trimmed === "999") {
            values.push(null);
            continue;
        }
        const val = Number(trimmed);
        if (Number.isNaN(val)) {
            throw new Error(`Invalid hourly value '${segment}' at hour ${i}`);
        }
        values.push(val);
    }
    return values;
}

function parseEventsFromSegment(segment: string): TideEvent[] {
    const events: TideEvent[] = [];
    const usable = segment.length - (segment.length % 7);
    const s = segment.slice(0, usable);

    for (let i = 0; i + 7 <= s.length; i += 7) {
        const blk = s.slice(i, i + 7);
        const timeRaw = blk.slice(0, 4);
        const heightRaw = blk.slice(4, 7);

        let t = timeRaw.trim();
        if (!t) continue;
        if (t === "9999") continue;
        t = t.padStart(4, "0");
        const hh = Number(t.slice(0, 2));
        const mm = Number(t.slice(2, 4));
        if (Number.isNaN(hh) || Number.isNaN(mm) || hh > 23 || mm > 59 || hh < 0 || mm < 0) continue;

        const hTrim = heightRaw.trim();
        if (!hTrim) continue;
        if (hTrim === "999") continue;
        const hNum = Number(hTrim);
        if (Number.isNaN(hNum)) continue;

        events.push({ time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, heightCm: hNum });
    }

    return events;
}

function parseDateField(field: string, expectedYear: number): { year: number; month: number; day: number } {
    const raw = field.replace(/\s+$/g, "");
    if (raw.length < 2) throw new Error(`Invalid date field '${field}'`);
    const yyStr = raw.slice(0, 2);
    const yy = Number(yyStr);
    if (!Number.isInteger(yy)) throw new Error(`Invalid YY '${yyStr}' from '${field}'`);
    const year = YEAR_BASE + yy;
    if (year !== expectedYear) throw new Error(`Year mismatch in date field: parsed=${year} expected=${expectedYear}`);

    const rest = raw.slice(2).trim();
    if (!rest) throw new Error(`Empty month/day in '${field}'`);

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
            throw new Error(`Expected MDD or MMDD but got '${md}' from '${field}'`);
        }
    } else {
        throw new Error(`Cannot parse month/day from '${field}'`);
    }

    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
        throw new Error(`Invalid month/day parsed from '${field}': ${month}/${day}`);
    }

    return { year, month, day };
}

function splitEventsFromLine(line: string) {
    const highSegment = line.slice(IDX_HIGH_START, IDX_HIGH_END);
    const lowSegment = line.slice(IDX_LOW_START, IDX_LOW_END);

    const highEvents = parseEventsFromSegment(highSegment).slice(0, 2);
    const lowEvents = parseEventsFromSegment(lowSegment).slice(0, 2);

    return { highTides: highEvents, lowTides: lowEvents };
}

function parseLine(line: string, expectedYear: number, expectedStation: string): { date: string; day: TideDay } {
    if (line.length < IDX_LOW_END) {
        line = line.padEnd(IDX_LOW_END, " ");
    }

    const hourlyRaw = line.slice(IDX_HOURLY_START, IDX_HOURLY_END);
    const hourly = parseHourly(hourlyRaw);

    const dateField = line.slice(IDX_DATE_START, IDX_DATE_END);
    const { year, month, day } = parseDateField(dateField, expectedYear);

    const stationField = line.slice(IDX_STATION_START, IDX_STATION_END).trim().toUpperCase();
    if (stationField !== expectedStation) {
        throw new Error(`Station mismatch in line: ${stationField} (expected ${expectedStation})`);
    }

    const { highTides, lowTides } = splitEventsFromLine(line);
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
