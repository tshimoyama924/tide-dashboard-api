import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, RestError } from "@azure/storage-blob";

type Station = { station_code: string; name: string };

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

const STATIONS_CONTAINER = "master";
const TIDE_CONTAINER = "data";
const TIDE_PATH_PREFIX = "tide";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_CONTROL = "public, max-age=86400";

const stationCache: { expiresAt: number; data: Station[] } = { expiresAt: 0, data: [] };
const tideCache = new Map<string, { expiresAt: number; data: TideYear; etag?: string }>();

const normalizeEtag = (value: string): string => value.trim().replace(/^W\//i, "").replace(/^"+|"+$/g, "");

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
): Promise<{ data?: T; etag?: string }> {
    const service = createBlobService(context);
    if (!service) {
        return {};
    }
    const client = service.getContainerClient(container).getBlobClient(blobPath);
    try {
        const res = await client.download();
        const etag = res.etag ?? undefined;
        const stream = res.readableStreamBody;
        if (!stream) return { etag };

        const chunks: Buffer[] = [];
        for await (const c of stream) {
            chunks.push(typeof c === "string" ? Buffer.from(c) : c);
        }
        return { data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T, etag };
    } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) {
            return {};
        }
        context.log(`Failed to read blob ${container}/${blobPath}: ${err}`);
        throw err;
    }
}

async function getStations(context: InvocationContext): Promise<Station[] | undefined> {
    const now = Date.now();
    if (stationCache.expiresAt > now && stationCache.data.length > 0) {
        return stationCache.data;
    }
    const { data: stations } = await downloadJson<Station[]>(context, STATIONS_CONTAINER, "stations.json");
    if (!stations) return undefined;
    stationCache.data = stations;
    stationCache.expiresAt = now + CACHE_TTL_MS;
    return stations;
}

function ensureHourly24(values?: Array<number | null>): Array<number | null> {
    const result: Array<number | null> = new Array(24).fill(null);
    if (!values) return result;
    for (let i = 0; i < 24; i++) {
        if (i < values.length) {
            const v = values[i];
            result[i] = v === null || v === undefined ? null : v;
        }
    }
    return result;
}

function isValidDateString(date: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const d = new Date(date + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return false;
    const [y, m, day] = date.split("-").map((n) => parseInt(n, 10));
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day;
}

async function getTideYear(
    context: InvocationContext,
    year: number,
    stationCode: string
): Promise<{ data?: TideYear; etag?: string }> {
    const cacheKey = `${year}-${stationCode}`;
    const cached = tideCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return { data: cached.data, etag: cached.etag };
    }

    const blobPath = `${TIDE_PATH_PREFIX}/${year}/${stationCode}.json`;
    const { data, etag } = await downloadJson<TideYear>(context, TIDE_CONTAINER, blobPath);
    if (!data) return {};

    tideCache.set(cacheKey, { data, etag, expiresAt: now + CACHE_TTL_MS });
    return { data, etag };
}

function makeResponseBody(stationCode: string, date: string, tideYear: TideYear, tideDay: TideDay) {
    const hourly = ensureHourly24(tideDay.hourly);
    const highTides = tideDay.highTides ?? [];
    const lowTides = tideDay.lowTides ?? [];

    const year = tideYear.year ?? parseInt(date.slice(0, 4), 10);
    const dataVersion = tideYear.meta?.dataVersion ?? year;

    return {
        station_code: stationCode,
        date,
        hourly,
        highTides,
        lowTides,
        meta: {
            source: "JMA",
            year,
            dataVersion: String(dataVersion),
        },
    };
}

export async function GetTides(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
        const stations = await getStations(context);
        if (!stations) {
            return { status: 500, jsonBody: { error: "Stations master could not be loaded." } };
        }
        const known = stations.some((s) => s.station_code === stationCode);
        if (!known) {
            return { status: 400, jsonBody: { error: "station_code is not defined in master" } };
        }

        const year = parseInt(date.slice(0, 4), 10);
        const { data: tideYear, etag } = await getTideYear(context, year, stationCode);
        if (!tideYear) {
            return {
                status: 404,
                headers: { "Cache-Control": "no-store" },
                jsonBody: { error: "Tide data not found for the specified year." },
            };
        }

        const tideDay = tideYear.days?.[date];
        if (!tideDay) {
            return {
                status: 404,
                headers: { "Cache-Control": "no-store" },
                jsonBody: { error: "Tide data not found for the specified date." },
            };
        }

        if (etag && request.headers.get("if-none-match")) {
            const ifNoneMatch = request.headers.get("if-none-match")!;
            if (normalizeEtag(ifNoneMatch) === normalizeEtag(etag)) {
                return {
                    status: 304,
                    headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
                };
            }
        }

        return {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": CACHE_CONTROL,
                ...(etag ? { ETag: etag } : {}),
            },
            jsonBody: makeResponseBody(stationCode, date, tideYear, tideDay),
        };
    } catch (err) {
        context.log(`Error loading tides: ${err}`);
        return {
            status: 500,
            headers: { "Cache-Control": "no-store" },
            jsonBody: { error: "Unexpected error loading tides." },
        };
    }
}

app.http("GetTides", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "v1/tides",
    handler: GetTides,
});
