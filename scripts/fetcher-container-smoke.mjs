import { execFileSync } from "node:child_process";

const image = `read-it-later-safe-fetch:ci-${process.pid}`;
const name = `safe-fetch-smoke-${process.pid}`;
let containerId;

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

try {
  docker(["build", "--platform", "linux/amd64", "--tag", image, "fetcher"]);
  containerId = docker([
    "run", "--detach", "--name", name,
    "--publish", "127.0.0.1::8080",
    "--env", "APP_ORIGIN=https://read.pajdzik.pl",
    image,
  ]);
  const mapping = docker(["port", containerId, "8080/tcp"]);
  const port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error("Docker did not expose a local health port");

  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && await response.text() === "ok") { healthy = true; break; }
    } catch { /* wait for the container process to start */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error("Safe fetch container did not become healthy");

  const response = await fetch(`http://127.0.0.1:${port}/v1/fetch`, {
    method: "POST",
    signal: AbortSignal.timeout(6_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, url: "https://127.0.0.1/" }),
  });
  const result = await response.json();
  if (response.status !== 200 || result?.version !== 1 || result?.ok !== false || result?.error !== "unsafe_destination") {
    throw new Error("Safe fetch container failed its fixed private-destination rejection check");
  }
  process.stdout.write("Container image built, health route passed, and private URL was rejected.\n");
} finally {
  if (containerId) {
    try { docker(["rm", "--force", containerId]); } catch { /* cleanup is best effort after a failed Docker command */ }
  }
  try { docker(["image", "rm", "--force", image]); } catch { /* temporary CI image cleanup */ }
}
