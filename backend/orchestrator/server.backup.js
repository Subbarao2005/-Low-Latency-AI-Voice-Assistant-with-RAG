/**
 * Streaming relay: browser <-> n8n webhook.
 *
 * Browser
 *   -> WebSocket
 *   -> this relay
 *   -> n8n webhook
 *
 * n8n
 *   -> callback URL on this relay
 *   -> this relay
 *   -> browser WebSocket
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.RELAY_PORT || 8090);

// n8n is exposed on the Windows host at port 5678.
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "http://localhost:5678/webhook/voice-assistant";

// IMPORTANT:
// n8n runs inside Docker, while this relay runs on Windows.
// Therefore n8n must use host.docker.internal to reach this relay.
const CALLBACK_BASE_URL =
  process.env.RELAY_CALLBACK_BASE_URL ||
  `http://host.docker.internal:${PORT}`;

// ------------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/callback/")) {
    return handleN8nCallback(req, res);
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
  });

  res.end("voice-assistant relay ok");
});

// ------------------------------------------------------------
// WEBSOCKET SERVER
// ------------------------------------------------------------

const wss = new WebSocketServer({
  server,
});

// turnId -> browser WebSocket
const activeTurns = new Map();

// ws -> latest turnId
const latestTurnPerSocket = new Map();

// ------------------------------------------------------------
// BROWSER CONNECTION
// ------------------------------------------------------------

wss.on("connection", (ws) => {
  console.log("Browser WebSocket connected");

  ws.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "invalid JSON",
        })
      );

      return;
    }

    if (msg.type !== "transcript") {
      return;
    }

    const turnId = msg.turnId || randomUUID();

    // Register this turn.
    activeTurns.set(turnId, ws);

    // New turn supersedes previous turn.
    latestTurnPerSocket.set(ws, turnId);

    const callbackUrl =
      `${CALLBACK_BASE_URL}/callback/${turnId}`;

    console.log(
      `[${turnId}] Sending transcript to n8n`
    );

    console.log(
      `[${turnId}] Callback URL: ${callbackUrl}`
    );

    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          turnId,

          text: msg.text || "",

          isFinal: !!msg.isFinal,

          callbackUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `n8n returned HTTP ${response.status}`
        );
      }

      console.log(
        `[${turnId}] n8n accepted transcript`
      );
    } catch (err) {
      console.error(
        `[${turnId}] n8n request failed:`,
        err.message
      );

      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error",
            turnId,
            message: `n8n unreachable: ${err.message}`,
          })
        );
      }

      activeTurns.delete(turnId);
    }
  });

  // ----------------------------------------------------------
  // BROWSER DISCONNECT
  // ----------------------------------------------------------

  ws.on("close", () => {
    console.log("Browser WebSocket disconnected");

    for (const [turnId, socket] of activeTurns.entries()) {
      if (socket === ws) {
        activeTurns.delete(turnId);
      }
    }

    latestTurnPerSocket.delete(ws);
  });

  ws.on("error", (err) => {
    console.error(
      "WebSocket error:",
      err.message
    );
  });
});

// ------------------------------------------------------------
// n8n CALLBACK
// ------------------------------------------------------------

function handleN8nCallback(req, res) {
  const turnId = req.url.split("/callback/")[1];

  const ws = activeTurns.get(turnId);

  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    // Always acknowledge n8n.
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });

    res.end("ok");

    // Browser no longer connected.
    if (!ws || ws.readyState !== ws.OPEN) {
      console.log(
        `[${turnId}] Browser disconnected; callback dropped`
      );

      return;
    }

    // Ignore stale turns after barge-in.
    if (latestTurnPerSocket.get(ws) !== turnId) {
      console.log(
        `[${turnId}] Stale callback dropped`
      );

      return;
    }

    try {
      const payload = JSON.parse(body);

      console.log(
        `[${turnId}] Callback: ${payload.type}`
      );

      ws.send(
        JSON.stringify({
          ...payload,
          turnId,
        })
      );

      // Turn completed.
      if (payload.type === "done") {
        activeTurns.delete(turnId);

        console.log(
          `[${turnId}] Turn completed`
        );
      }
    } catch (err) {
      console.error(
        `[${turnId}] Invalid callback payload:`,
        err.message
      );

      ws.send(
        JSON.stringify({
          type: "error",
          turnId,
          message: `bad callback payload: ${err.message}`,
        })
      );
    }
  });
}

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

server.listen(PORT, () => {
  console.log(
    `Voice assistant relay listening on :${PORT}`
  );

  console.log(
    `Forwarding transcripts to n8n webhook: ${N8N_WEBHOOK_URL}`
  );

  console.log(
    `n8n callback base URL: ${CALLBACK_BASE_URL}`
  );
});

module.exports = server;