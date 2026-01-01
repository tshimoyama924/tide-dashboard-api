import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, RestError } from "@azure/storage-blob";

type WeatherCodeEntry = {
    icon_day: string;
    icon_night: string;
    group: string;
    ja: string;
    en: string;
};

type WeatherCodeMap = Record<string, WeatherCodeEntry>;

const WEATHER_CONTAINER = "master";
const WEATHER_BLOB_PATH = "weather_code.json";
const CACHE_CONTROL = "public, max-age=86400"; // 1 day

const weatherCache: { loaded: boolean; data?: WeatherCodeMap; error?: string } = {
    loaded: false,
};

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

async function loadWeatherCodes(context: InvocationContext): Promise<WeatherCodeMap | undefined> {
    if (weatherCache.loaded) {
        return weatherCache.data;
    }
    try {
        const data = await downloadJson<WeatherCodeMap>(context, WEATHER_CONTAINER, WEATHER_BLOB_PATH);
        if (!data) {
            weatherCache.loaded = true;
            weatherCache.error = "weather_code blob not found";
            return undefined;
        }
        weatherCache.loaded = true;
        weatherCache.data = data;
        return data;
    } catch (err) {
        weatherCache.loaded = true;
        weatherCache.error = err instanceof Error ? err.message : String(err);
        return undefined;
    }
}

function buildResponse(status: number, body: unknown): HttpResponseInit {
    return {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": CACHE_CONTROL,
        },
        jsonBody: body,
    };
}

export async function GetWeatherCodes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const code = (request.params?.code || "").trim();

    const codes = await loadWeatherCodes(context);
    if (!codes) {
        context.log(`Weather codes not available: ${weatherCache.error ?? "unknown error"}`);
        return { status: 500, jsonBody: { error: "internal_error" } };
    }

    // Full list
    if (!code) {
        return buildResponse(200, codes);
    }

    const entry = codes[code];
    if (!entry) {
        return buildResponse(404, { error: "weather_code_not_found", code });
    }

    return buildResponse(200, { code, ...entry });
}

app.http("GetWeatherCodes", {
    route: "v1/weather-codes/{code?}",
    methods: ["GET"],
    authLevel: "anonymous",
    handler: GetWeatherCodes,
});
