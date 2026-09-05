const assert = require("node:assert/strict");
const WebSocket = require("../backend/orchestrator/node_modules/ws");

const baseUrl = (process.env.TEST_BASE_URL || "http://localhost:8090").replace(/\/$/, "");
const wsUrl = process.env.TEST_WS_URL || baseUrl.replace(/^http/, "ws");

async function checkHttp(path, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `${path}: ${response.status} ${body}`);
  return body;
}

async function checkWebSocket(path) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}${path}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`${path}: connection timeout`));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  const health = JSON.parse(await checkHttp("/health"));
  assert.deepEqual(health, { status: "ok", service: "voice-assistant-relay" });
  await checkHttp("/");
  await checkWebSocket("/");
  await checkWebSocket("/stt");

  const unsupported = await fetch(`${baseUrl}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_everything", data: {} }),
  });
  assert.equal(unsupported.status, 400);
  assert.deepEqual((await unsupported.json()).error, { code: "UNSUPPORTED_ACTION", message: "Unsupported action" });
  console.log(`Smoke tests passed for ${baseUrl}`);
}

main().catch((error) => {
  console.error(`Smoke tests failed: ${error.message}`);
  process.exitCode = 1;
});