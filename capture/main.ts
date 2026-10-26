import { createCaptureServer } from "./server";

const appOrigin = process.env.APP_ORIGIN;
if (!appOrigin || !["http:", "https:"].includes(new URL(appOrigin).protocol)) throw new Error("missing_app_origin");
createCaptureServer(appOrigin).listen(8080, "0.0.0.0");
