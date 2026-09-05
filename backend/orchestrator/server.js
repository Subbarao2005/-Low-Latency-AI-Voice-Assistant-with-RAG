/**
 * Low-Latency Voice Assistant Relay
 *
 * Browser
 *   ├── /stt WebSocket
 *   │      -> this relay
 *   │      -> Sarvam STT WebSocket
 *   │
 *   └── / WebSocket
 *          -> this relay
 *          -> n8n webhook
 *
 * n8n
 *   -> callback URL on this relay
 *   -> this relay
 *   -> browser WebSocket
 *
 * IMPORTANT:
 * - Sarvam API key is loaded server-side from ../../.env
 * - Browser does NOT need to send the Sarvam API key
 */

require("dotenv").config({ path: "../../.env" });

const http = require("http");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { randomUUID } = require("crypto");
const { routeAction } = require("./actions/actionRouter");

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const PORT = Number(
  process.env.PORT ||
  process.env.RELAY_PORT ||
  8090
);

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "http://localhost:5678/webhook/voice-assistant";

const CALLBACK_BASE_URL =
  process.env.RELAY_CALLBACK_BASE_URL ||
  `http://localhost:${PORT}`;

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

const SARVAM_STT_URL =
  process.env.SARVAM_STT_URL ||
  "wss://api.sarvam.ai/speech-to-text/ws";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// ------------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      service: "voice-assistant-relay",
    }));
  }

  if (req.method === "POST" && (req.url === "/action" || req.url === "/actions")) {
    return handleActionRequest(req, res);
  }

  if (req.url.startsWith("/callback/")) {
    return handleN8nCallback(req, res);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });

  res.end("voice-assistant relay ok");
});

function handleActionRequest(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      const result = await routeAction(JSON.parse(body));
      res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("Action request failed:", error.message);
      res.writeHead(error.statusCode || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.publicMessage || "Invalid action request" }));
    }
  });
}

// ------------------------------------------------------------
// WEBSOCKET SERVER
// ------------------------------------------------------------

const wss = new WebSocketServer({
  server,
});

// turnId -> browser WebSocket
const activeTurns = new Map();

// browser WebSocket -> latest turnId
const latestTurnPerSocket = new Map();

// ------------------------------------------------------------
// WEBSOCKET CONNECTION
// ------------------------------------------------------------

wss.on("connection", (ws, req) => {
  const requestUrl = req.url || "/";

  // ----------------------------------------------------------
  // SARVAM STT PROXY
  // ----------------------------------------------------------

  if (requestUrl.startsWith("/stt")) {
    return handleSarvamSttConnection(ws);
  }

  // ----------------------------------------------------------
  // NORMAL N8N RELAY
  // ----------------------------------------------------------

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

      if (ws.readyState === WebSocket.OPEN) {
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
// SARVAM STT CONNECTION
// ------------------------------------------------------------

function handleSarvamSttConnection(browserWs) {
  console.log("Browser connected to /stt");

  if (!SARVAM_API_KEY) {
    browserWs.send(JSON.stringify({ type: "stt_error", message: "STT is not configured on the server" }));
    browserWs.close(1011, "STT not configured");
    return;
  }

  const sttUrl =
    `${SARVAM_STT_URL}` +
    "?language-code=en-IN" +
    "&model=saaras:v4" +
    "&mode=transcribe" +
    "&sample_rate=16000" +
    "&input_audio_codec=pcm_s16le";

  console.log(
    "Connecting relay to Sarvam STT..."
  );

  const sarvamWs = new WebSocket(sttUrl, {
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
    },
  });

  let sarvamReady = false;

  // ----------------------------------------------------------
  // SARVAM OPEN
  // ----------------------------------------------------------

  sarvamWs.on("open", () => {
    sarvamReady = true;

    console.log(
      "Sarvam STT WebSocket connected"
    );

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "stt_ready",
        })
      );
    }
  });

  // ----------------------------------------------------------
  // SARVAM MESSAGE
  // ----------------------------------------------------------

  sarvamWs.on("message", (data) => {
    const message = data.toString();

    console.log(
      "Sarvam STT:",
      message
    );

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(message);
    }
  });

  // ----------------------------------------------------------
  // SARVAM ERROR
  // ----------------------------------------------------------

  sarvamWs.on("error", (err) => {
    console.error(
      "Sarvam STT error:",
      err.message
    );

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "stt_error",
          message: err.message,
        })
      );
    }
  });

  // ----------------------------------------------------------
  // SARVAM CLOSE
  // ----------------------------------------------------------

  sarvamWs.on("close", (code, reason) => {
    sarvamReady = false;

    console.log(
      `Sarvam STT disconnected: ${code} ${reason || ""}`
    );

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "stt_closed",
          code,
        })
      );
    }
  });

  // ----------------------------------------------------------
  // BROWSER MESSAGE
  // ----------------------------------------------------------

  browserWs.on("message", (raw, isBinary) => {
    if (!sarvamReady) {
      return;
    }

    try {
      // Browser sends raw PCM16 binary audio.
      if (isBinary || Buffer.isBuffer(raw)) {
        const audioBuffer = Buffer.from(raw);

        const audioMessage = {
          audio: {
            data: audioBuffer.toString("base64"),
            sample_rate: "16000",

            // IMPORTANT:
            // Sarvam expects audio.encoding to be audio/wav
            // while input_audio_codec above remains pcm_s16le.
            encoding: "audio/wav",
          },
        };

        if (sarvamWs.readyState === WebSocket.OPEN) {
          sarvamWs.send(
            JSON.stringify(audioMessage)
          );
        }

        return;
      }

      // Also support JSON messages from the browser.
      const msg = JSON.parse(raw.toString());

      if (msg.type === "audio") {
        const audioMessage = {
          audio: {
            data: msg.data,
            sample_rate: String(
              msg.sample_rate || 16000
            ),

            // Force the valid Sarvam encoding.
            encoding: "audio/wav",
          },
        };

        if (sarvamWs.readyState === WebSocket.OPEN) {
          sarvamWs.send(
            JSON.stringify(audioMessage)
          );
        }

        return;
      }

      // Forward any explicitly formatted Sarvam message.
      if (
        msg.audio &&
        sarvamWs.readyState === WebSocket.OPEN
      ) {
        sarvamWs.send(
          JSON.stringify(msg)
        );
      }
    } catch (err) {
      console.error(
        "STT browser message error:",
        err.message
      );

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: "stt_error",
            message:
              `Invalid STT audio message: ${err.message}`,
          })
        );
      }
    }
  });

  // ----------------------------------------------------------
  // BROWSER CLOSE
  // ----------------------------------------------------------

  browserWs.on("close", () => {
    console.log(
      "Browser disconnected from /stt"
    );

    if (
      sarvamWs.readyState === WebSocket.OPEN ||
      sarvamWs.readyState === WebSocket.CONNECTING
    ) {
      sarvamWs.close();
    }
  });

  browserWs.on("error", (err) => {
    console.error(
      "STT browser WebSocket error:",
      err.message
    );

    if (
      sarvamWs.readyState === WebSocket.OPEN ||
      sarvamWs.readyState === WebSocket.CONNECTING
    ) {
      sarvamWs.close();
    }
  });
}

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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
          message:
            `bad callback payload: ${err.message}`,
        })
      );
    }
  });
}

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Voice assistant relay listening on :${PORT}`
  );

  console.log(
    `Forwarding transcripts to n8n webhook: ${N8N_WEBHOOK_URL}`
  );

  console.log(
    `Sarvam STT proxy: ws://localhost:${PORT}/stt`
  );

  console.log(
    `Sarvam STT upstream: ${SARVAM_STT_URL}`
  );

  console.log(
    `n8n callback base URL: ${CALLBACK_BASE_URL}`
  );

  console.log(
    `Sarvam API key loaded: ${Boolean(SARVAM_API_KEY)}`
  );
});

module.exports = server;