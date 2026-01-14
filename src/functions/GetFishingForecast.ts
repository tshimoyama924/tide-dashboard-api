import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, RestError } from "@azure/storage-blob";

type Station = {
    station_code: string;
    name: string;
    office_code: string;
    area_code: string;
    area_name?: string;
    forecast_area_code?: string | null;
};

type TideEvent = { time: string; heightCm: number };
type TideDay = { hourly: Array<number | null>; highTides: TideEvent[]; lowTides: TideEvent[] };
type TideYear = {
    station_code: string;
    year: number;
    days: Record<string, TideDay>;
    meta?: { source?: string; dataVersion?: string | number };
};

type FishingForecastResponse = {
    station: {
        station_code: string;
        name: string;
        office_code: string;
        area_code: string;
        area_name?: string;
        forecast_area_code?: string | null;
    };
    date: string;
    tide: {
        hourly_cm: Array<number | null>;
        high: { time: string; height_cm: number }[];
        low: { time: string; height_cm: number }[];
        meta: { source: "JMA"; year: number; dataVersion: string };
    };
    today: {
        weather: { code: string | null; text_ja: string | null; icon: string | null };
        wind_text: string | null;
        wave_text: string | null;
        pop: { time: string; value: number | null }[];
    };
    weekly: Array<{
        date: string;
        weather: { code: string | null; text_ja?: string | null; icon?: string | null };
        pop?: number | null;
        temp_min?: number | null;
        temp_max?: number | null;
        reliability?: string | null;
    }>;
    meta: {
        forecast_source: "JMA";
        forecast_report_datetime: string | null;
        weekly_temp_area?: { name: string; code: string } | null;
        used_area_code?: string | null;
        used_pop_area_code?: string | null;
    };
};

const STATIONS_CONTAINER = "master";
const STATIONS_BLOB = "stations.json";
const TIDE_CONTAINER = "data";
const TIDE_PATH_PREFIX = "tide";
const CACHE_TTL_STATION_MS = 10 * 60 * 1000;
const CACHE_TTL_TIDE_MS = 5 * 60 * 1000;
const CACHE_TTL_FORECAST_MS = 10 * 60 * 1000;
const CACHE_CONTROL_SUCCESS = "public, max-age=600";

const stationCache: { expiresAt: number; data?: Station[] } = { expiresAt: 0 };
const tideCache = new Map<string, { expiresAt: number; data: TideYear }>();
const forecastCache = new Map<string, { expiresAt: number; data: any }>();

function isValidDateString(date: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const d = new Date(date + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return false;
    const [y, m, day] = date.split("-").map((n) => parseInt(n, 10));
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day;
}

function getConnectionString(): string | undefined {
    return (
        process.env.AZURE_STORAGE_CONNECTION_STRING ||
        process.env.STATIONS_CONNECTION_STRING ||
        process.env.STORAGE_CONNECTION_STRING ||
        process.env.AzureWebJobsStorage
    );
}

function createBlobService(context: InvocationContext): BlobServiceClient | undefined {
    const conn = getConnectionString();
    if (!conn) {
        context.log("No storage connection string configured.");
        return undefined;
    }
    return BlobServiceClient.fromConnectionString(conn);
}

async function downloadJson<T>(
    context: InvocationContext,
    container: string,
    blobPath: string
): Promise<T | undefined> {
    const service = createBlobService(context);
    if (!service) return undefined;
    const client = service.getContainerClient(container).getBlobClient(blobPath);
    try {
        const res = await client.download();
        const stream = res.readableStreamBody;
        if (!stream) return undefined;
        const chunks: Buffer[] = [];
        for await (const c of stream) {
            chunks.push(typeof c === "string" ? Buffer.from(c) : c);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
    } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) {
            return undefined;
        }
        context.log(`Failed to read blob ${container}/${blobPath}: ${err}`);
        throw err;
    }
}

async function getStations(context: InvocationContext): Promise<Station[] | undefined> {
    const now = Date.now();
    if (stationCache.data && stationCache.expiresAt > now) {
        return stationCache.data;
    }
    const stations = await downloadJson<Station[]>(context, STATIONS_CONTAINER, STATIONS_BLOB);
    if (!stations) return undefined;
    stationCache.data = stations;
    stationCache.expiresAt = now + CACHE_TTL_STATION_MS;
    return stations;
}

async function getTideYear(
    context: InvocationContext,
    year: number,
    stationCode: string
): Promise<TideYear | undefined> {
    const cacheKey = `${year}-${stationCode}`;
    const cached = tideCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }
    const blobPath = `${TIDE_PATH_PREFIX}/${year}/${stationCode}.json`;
    const data = await downloadJson<TideYear>(context, TIDE_CONTAINER, blobPath);
    if (!data) return undefined;
    tideCache.set(cacheKey, { data, expiresAt: now + CACHE_TTL_TIDE_MS });
    return data;
}

async function fetchForecast(context: InvocationContext, officeCode: string): Promise<any | undefined> {
    const cached = forecastCache.get(officeCode);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }
    const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            context.log(`JMA fetch failed: ${res.status}`);
            return undefined;
        }
        const json = await res.json();
        forecastCache.set(officeCode, { data: json, expiresAt: now + CACHE_TTL_FORECAST_MS });
        return json;
    } catch (err) {
        context.log(`JMA fetch error: ${err}`);
        return undefined;
    }
}

// Helpers for JMA parsing
function getArray<T = any>(v: any): T[] {
    if (Array.isArray(v)) return v;
    if (v === undefined || v === null) return [];
    return [v];
}

function pickAreas(obj: any) {
    return getArray(obj?.areas || obj?.area || obj?.エリア);
}

function getAreaMeta(entry: any): { code: string | null; name: string | null } {
    const areaObj = entry?.area ?? entry?.エリア ?? entry;
    const code =
        areaObj?.code ??
        areaObj?.コード ??
        entry?.code ??
        entry?.コード ??
        null;
    const name =
        areaObj?.name ??
        areaObj?.名前 ??
        entry?.name ??
        entry?.名前 ??
        null;
    return { code: code !== undefined && code !== null ? String(code) : null, name: name !== undefined && name !== null ? String(name) : null };
}

function selectAreaByCodes(areas: any[], codes: Array<string | null | undefined>): { area?: any; used?: string } {
    const tryCodes = codes.filter((c): c is string => Boolean(c));
    for (const code of tryCodes) {
        const hit = areas.find((a: any) => getAreaMeta(a).code === code);
        if (hit) return { area: hit, used: code };
    }
    if (areas.length > 0) return { area: areas[0], used: undefined };
    return { area: undefined, used: undefined };
}

function toDatePart(iso: string): string | null {
    const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function toTimePart(iso: string): string | null {
    const m = iso.match(/T(\d{2}:\d{2})/);
    return m ? m[1] : null;
}
function toNumberOrNull(v: any): number | null {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

function buildToday(
    forecast: any,
    date: string,
    areaCode: string,
    forecastAreaCode?: string | null
): { today: FishingForecastResponse["today"]; usedAreaCode?: string | null; usedPopAreaCode?: string | null } {
    const timeSeries = getArray(forecast?.[0]?.timeSeries ?? forecast?.timeSeries);
    const weatherSeries = timeSeries.find((ts: any) => {
        const defs = getArray(ts?.timeDefines);
        if (!defs.length) return false;
        const areas = pickAreas(ts);
        const a0 = areas[0];
        return Boolean(a0 && (a0.weatherCodes || a0["weatherCodes"] || a0?.天気コード));
    });
    const popSeries = timeSeries.find((ts: any) => {
        const defs = getArray(ts?.timeDefines);
        if (!defs.length) return false;
        const areas = pickAreas(ts);
        const a0 = areas[0];
        return Boolean(a0 && (a0.pops || a0.ポップス));
    });

    const today: FishingForecastResponse["today"] = {
        weather: { code: null, text_ja: null, icon: null },
        wind_text: null,
        wave_text: null,
        pop: [],
    };

    let usedAreaCode: string | null | undefined;
    let usedPopAreaCode: string | null | undefined;

    if (weatherSeries) {
        const areas = pickAreas(weatherSeries);
        const { area, used } = selectAreaByCodes(areas, [areaCode, forecastAreaCode]);
        usedAreaCode = used ?? null;
        const timeDefines: string[] = getArray(weatherSeries.timeDefines);
        const idx = timeDefines.findIndex((t) => toDatePart(t) === date);
        if (idx >= 0 && area) {
            const codes = getArray(area.weatherCodes || area["weatherCodes"] || area?.天気コード);
            const texts = getArray(area.weathers || area["weathers"] || area?.天気);
            const winds = getArray(area.winds || area["winds"] || area?.風);
            const waves = getArray(area.waves || area["waves"] || area?.波);
            const code = codes[idx] ?? null;
            const text = texts[idx] ?? null;
            today.weather.code = code ?? null;
            today.weather.text_ja = text ?? null;
            today.weather.icon = code ? `${code}.svg` : null;
            today.wind_text = winds[idx] ?? null;
            today.wave_text = waves[idx] ?? null;
        }
    }

    if (popSeries) {
        const areas = pickAreas(popSeries);
        const { area, used } = selectAreaByCodes(areas, [areaCode, forecastAreaCode]);
        usedPopAreaCode = used ?? null;
        const timeDefines: string[] = getArray(popSeries.timeDefines);
        const pops = getArray(area?.pops || area?.["pops"] || area?.ポップス);
        today.pop = timeDefines
            .map((t, i) => {
                const d = toDatePart(t);
                if (d !== date) return null;
                return { time: toTimePart(t) ?? "", value: toNumberOrNull(pops[i]) };
            })
            .filter((v): v is { time: string; value: number | null } => Boolean(v));
    }

    return { today, usedAreaCode, usedPopAreaCode };
}

function buildWeekly(forecast: any, officeCode: string) {
    const f: any = forecast;
    const tsCandidate = Array.isArray(f)
        ? (f as any)[1]?.timeSeries ?? (f as any)[0]?.timeSeries ?? (f as any)?.timeSeries
        : (f as any)?.timeSeries;
    const timeSeries = getArray(tsCandidate);

    const weeklyWeather = timeSeries.find((ts: any) => {
        const defs = getArray(ts?.timeDefines);
        if (defs.length < 5) return false;
        const a0 = pickAreas(ts)[0];
        return Boolean(a0 && (a0.weatherCodes || a0["weatherCodes"] || a0?.天気コード));
    });
    const weeklyPops = timeSeries.find((ts: any) => {
        const defs = getArray(ts?.timeDefines);
        if (defs.length < 5) return false;
        const a0 = pickAreas(ts)[0];
        return Boolean(a0 && (a0.pops || a0["pops"] || a0?.ポップス));
    });
    const tempSeries = timeSeries.find((ts: any) => {
        const defs = getArray(ts?.timeDefines);
        if (defs.length < 5) return false;
        const a0 = pickAreas(ts)[0];
        return Boolean(a0 && (a0.tempsMin || a0["tempsMin"] || a0?.tempsMax || a0["tempsMax"] || a0?.temps));
    });

    const weeklyMap = new Map<string, FishingForecastResponse["weekly"][number]>();

    if (weeklyWeather) {
        const defs: string[] = getArray(weeklyWeather.timeDefines);
        const { area } = selectAreaByCodes(pickAreas(weeklyWeather), [officeCode]);
        const codes = getArray(area?.weatherCodes || area?.["weatherCodes"] || area?.天気コード);
        const reliabilities = getArray(area?.reliabilities || area?.["reliabilities"] || area?.信頼性);
        defs.forEach((t, i) => {
            const date = toDatePart(t);
            if (!date) return;
            const code = codes[i] ?? null;
            const entry = weeklyMap.get(date) ?? {
                date,
                weather: { code: null, text_ja: null, icon: null },
                pop: null,
                temp_min: null,
                temp_max: null,
                reliability: null,
            };
            entry.weather = { code, text_ja: null, icon: code ? `${code}.svg` : null };
            if (reliabilities[i] !== undefined) entry.reliability = reliabilities[i] ?? null;
            weeklyMap.set(date, entry);
        });
    }

    if (weeklyPops) {
        const defs: string[] = getArray(weeklyPops.timeDefines);
        const { area } = selectAreaByCodes(pickAreas(weeklyPops), [officeCode]);
        const pops = getArray(area?.pops || area?.["pops"] || area?.ポップス);
        defs.forEach((t, i) => {
            const date = toDatePart(t);
            if (!date) return;
            const entry =
                weeklyMap.get(date) ??
                {
                    date,
                    weather: { code: null, text_ja: null, icon: null },
                    pop: null,
                    temp_min: null,
                    temp_max: null,
                    reliability: null,
                };
            entry.pop = toNumberOrNull(pops[i]);
            weeklyMap.set(date, entry);
        });
    }

    let weeklyTempArea: { name: string; code: string } | null = null;
    if (tempSeries) {
        const defs: string[] = getArray(tempSeries.timeDefines);
        const { area } = selectAreaByCodes(pickAreas(tempSeries), [officeCode]);
        if (area) {
            const meta = getAreaMeta(area);
            weeklyTempArea = { name: meta.name ?? "", code: meta.code ?? "" };
        }
        const mins = getArray(area?.tempsMin || area?.["tempsMin"] || area?.temps?.min || area?.temps);
        const maxs = getArray(area?.tempsMax || area?.["tempsMax"] || area?.temps?.max || area?.temps);
        defs.forEach((t, i) => {
            const date = toDatePart(t);
            if (!date) return;
            const entry =
                weeklyMap.get(date) ??
                {
                    date,
                    weather: { code: null, text_ja: null, icon: null },
                    pop: null,
                    temp_min: null,
                    temp_max: null,
                    reliability: null,
                };
            entry.temp_min = toNumberOrNull(mins[i]);
            entry.temp_max = toNumberOrNull(maxs[i]);
            weeklyMap.set(date, entry);
        });
    }

    return { weekly: Array.from(weeklyMap.values()), weeklyTempArea };
}

export async function GetFishingForecast(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);
    const stationCode = (request.query.get("station_code") || "").trim().toUpperCase();
    const date = (request.query.get("date") || "").trim();

    if (!stationCode) {
        return { status: 400, jsonBody: { error: "station_code is required" } };
    }
    if (!date) {
        return { status: 400, jsonBody: { error: "date is required" } };
    }
    if (!isValidDateString(date)) {
        return { status: 400, jsonBody: { error: "date must be in YYYY-MM-DD format" } };
    }

    try {
        // stations
        const stations = await getStations(context);
        if (!stations) {
            return { status: 500, headers: { "Cache-Control": "no-store" }, jsonBody: { error: "Stations master could not be loaded." } };
        }
        const station = stations.find((s) => s.station_code === stationCode);
        if (!station) {
            return { status: 404, headers: { "Cache-Control": "no-store" }, jsonBody: { error: "station_code is not defined in master" } };
        }

        // tide
        const year = parseInt(date.slice(0, 4), 10);
        const tideYear = await getTideYear(context, year, stationCode);
        if (!tideYear) {
            return { status: 404, headers: { "Cache-Control": "no-store" }, jsonBody: { error: "Tide data not found for the specified year." } };
        }
        const tideDay = tideYear.days?.[date];
        if (!tideDay) {
            return { status: 404, headers: { "Cache-Control": "no-store" }, jsonBody: { error: "Tide data not found for the specified date." } };
        }

        // forecast
        const forecast = await fetchForecast(context, station.office_code);
        if (!forecast) {
            return { status: 502, headers: { "Cache-Control": "no-store" }, jsonBody: { error: "Failed to fetch JMA forecast." } };
        }

        const { today, usedAreaCode, usedPopAreaCode } = buildToday(forecast, date, station.area_code, station.forecast_area_code ?? undefined);
        const { weekly, weeklyTempArea } = buildWeekly(forecast, station.office_code);
        const reportDatetime = forecast?.[0]?.reportDatetime || forecast?.[0]?.reportdatetime || forecast?.reportDatetime || null;

        const response: FishingForecastResponse = {
            station: {
                station_code: station.station_code,
                name: station.name,
                office_code: station.office_code,
                area_code: station.area_code,
                area_name: station.area_name,
                forecast_area_code: station.forecast_area_code ?? null,
            },
            date,
            tide: {
                hourly_cm: tideDay.hourly ?? [],
                high: (tideDay.highTides ?? []).map((h) => ({ time: h.time, height_cm: h.heightCm })),
                low: (tideDay.lowTides ?? []).map((l) => ({ time: l.time, height_cm: l.heightCm })),
                meta: {
                    source: "JMA",
                    year: tideYear.year ?? year,
                    dataVersion: String(tideYear.meta?.dataVersion ?? tideYear.year ?? year),
                },
            },
            today,
            weekly,
            meta: {
                forecast_source: "JMA",
                forecast_report_datetime: reportDatetime ?? null,
                weekly_temp_area: weeklyTempArea ?? undefined,
                used_area_code: usedAreaCode ?? null,
                used_pop_area_code: usedPopAreaCode ?? null,
            },
        };

        return {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": CACHE_CONTROL_SUCCESS },
            jsonBody: response,
        };
    } catch (err) {
        context.log(`Error in fishing-forecast: ${err}`);
        return {
            status: 500,
            headers: { "Cache-Control": "no-store" },
            jsonBody: { error: "Unexpected error loading fishing forecast." },
        };
    }
}

app.http("GetFishingForecast", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "v1/fishing-forecast",
    handler: GetFishingForecast,
});
