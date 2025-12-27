import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_CONTAINER = "master";
const DEFAULT_BLOB_NAME = "stations.json";

type Station = { station_code: string; name: string };

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

async function readStationsFromBlob(context: InvocationContext): Promise<Station[] | undefined> {
    const connectionString =
        process.env.STATIONS_CONNECTION_STRING ||
        process.env.STORAGE_CONNECTION_STRING ||
        process.env.AzureWebJobsStorage;

    if (!connectionString) {
        context.log("No storage connection string configured, skipping blob fetch.");
        return undefined;
    }

    try {
        const containerName = process.env.STATIONS_CONTAINER || DEFAULT_CONTAINER;
        const blobName = process.env.STATIONS_BLOB || DEFAULT_BLOB_NAME;

        const service = BlobServiceClient.fromConnectionString(connectionString);
        const container = service.getContainerClient(containerName);
        const blob = container.getBlobClient(blobName);

        const download = await blob.download();
        if (!download.readableStreamBody) {
            context.log(`Blob ${containerName}/${blobName} has no readable stream body.`);
            return undefined;
        }

        const data = await streamToBuffer(download.readableStreamBody);
        return JSON.parse(data.toString("utf-8")) as Station[];
    } catch (err) {
        context.log(`Failed to read blob: ${err}`);
        return undefined;
    }
}

async function readStationsFromFile(context: InvocationContext): Promise<Station[] | undefined> {
    const filePath = path.join(process.cwd(), DEFAULT_BLOB_NAME);
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content) as Station[];
    } catch (err) {
        context.log(`Failed to read local file ${filePath}: ${err}`);
        return undefined;
    }
}

export async function GetStations(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);

    try {
        const stations = (await readStationsFromBlob(context)) ?? (await readStationsFromFile(context));

        if (!stations) {
            return {
                status: 500,
                jsonBody: { error: "stations.json could not be loaded from blob or local file." },
            };
        }

        return {
            status: 200,
            headers: { "Content-Type": "application/json" },
            jsonBody: stations,
        };
    } catch (err) {
        context.log(`Error loading stations: ${err}`);
        return {
            status: 500,
            jsonBody: { error: "Unexpected error loading stations." },
        };
    }
}

app.http("GetStations", {
    methods: ["GET"],
    authLevel: "anonymous",
    handler: GetStations,
});
