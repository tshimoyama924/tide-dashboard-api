import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const OPENAPI_PATH = path.join(process.cwd(), "docs", "openapi.v1.yaml");
const OPENAPI_CACHE_CONTROL = "public, max-age=300";
const DOCS_CACHE_CONTROL = "public, max-age=300";

const normalizeEtag = (value: string): string => value.trim().replace(/^W\//i, "").replace(/^"+|"+$/g, "");
const makeEtag = (content: string): string =>
    `"${crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32)}"`;

const swaggerHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tide Dashboard API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      background: #f0f2f5;
      color: #0f172a;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    #swagger-ui {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .topbar { display: none; }
    .swagger-ui, .swagger-ui * { color: #0f172a; }
    .swagger-ui .info .title { color: #0f172a; }
    .swagger-ui .info .title small.version-stamp {
      background: #e2e8f0;
      color: #0f172a;
    }
    .swagger-ui .scheme-container,
    .swagger-ui .opblock,
    .swagger-ui .opblock-tag-section,
    .swagger-ui .model-box,
    .swagger-ui .responses-inner,
    .swagger-ui table,
    .swagger-ui .model-box-control,
    .swagger-ui .response-col_description__inner {
      background: #f8fafc !important;
      border-color: #d5dce5 !important;
    }
    .swagger-ui .opblock-summary {
      background: #f8fafc !important;
      border-color: #d5dce5 !important;
      color: #0f172a !important;
    }
    .swagger-ui .opblock-summary-path,
    .swagger-ui .opblock-summary-description,
    .swagger-ui .opblock-tag,
    .swagger-ui .response-col_description__inner span,
    .swagger-ui .model-title,
    .swagger-ui .model .property,
    .swagger-ui .model .model-snippet {
      color: #0f172a !important;
    }
    .swagger-ui .model-box-control, .swagger-ui .model-box-control:focus {
      color: #0f172a !important;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      const ui = SwaggerUIBundle({
        url: "/api/v1/openapi.yaml",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`;

async function serveOpenApi(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
        const yaml = await fs.readFile(OPENAPI_PATH, "utf8");
        const etag = makeEtag(yaml);
        const ifNoneMatch = request.headers.get("if-none-match");
        if (ifNoneMatch && normalizeEtag(ifNoneMatch) === normalizeEtag(etag)) {
            return {
                status: 304,
                headers: {
                    ETag: etag,
                    "Cache-Control": OPENAPI_CACHE_CONTROL,
                },
            };
        }

        return {
            status: 200,
            headers: {
                "Content-Type": "text/yaml; charset=utf-8",
                "Cache-Control": OPENAPI_CACHE_CONTROL,
                ETag: etag,
            },
            body: yaml,
        };
    } catch (err) {
        context.log(`Failed to read OpenAPI yaml: ${err}`);
        return {
            status: 500,
            headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
            jsonBody: { error: "openapi_spec_not_available" },
        };
    }
}

function serveDocs(): HttpResponseInit {
    return {
        status: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": DOCS_CACHE_CONTROL,
        },
        body: swaggerHtml,
    };
}

app.http("GetOpenApiYaml", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "v1/openapi.yaml",
    handler: serveOpenApi,
});

app.http("GetSwaggerDocs", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "v1/docs",
    handler: serveDocs,
});
