/**
 * Low-Latency Voice Assistant Frontend
 *
 * Browser
 *   -> microphone
 *   -> backend STT relay
 *   -> Sarvam STT
 *   -> transcript
 *   -> relay/n8n
 *   -> streamed TTS
 *   -> browser playback
 *
 * IMPORTANT:
 * The Sarvam API key is NOT stored or sent by the browser.
 * STT authentication is handled by backend/orchestrator/server.js.
 */

const SILENCE_MS = 350;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000];

const els = {
  micBtn: document.getElementById("micBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  latencyBadge: document.getElementById("latencyBadge"),
  transcriptPane: document.getElementById("transcriptPane"),

  // Relay WebSocket URL.
  wsUrlInput: document.getElementById("wsUrlInput"),

  streamModeToggle: document.getElementById("streamModeToggle"),
};

const state = {
  recording: false,

  // Main relay connection for transcripts / TTS callbacks.
  relayWs: null,

  // Backend STT proxy connection.
  sttWs: null,

  mediaStream: null,
  audioCtx: null,
  processorNode: null,

  turnId: null,
  turnStartTs: null,
  firstAudioByteTs: null,

  silenceTimer: null,
  lastPartial: "",
  pendingTranscript: "",
  lastSentText: "",

  sttReady: false,

  playback: {
    queue: [],
    playing: false,
    nextStartTime: 0,
  },

  history: [],

  streamingAssistantText: "",
};

// ------------------------------------------------------------
// SETTINGS
// ------------------------------------------------------------

function loadSettings() {
  const s = JSON.parse(
    localStorage.getItem("va_settings") || "{}"
  );

  const configuredBackend =
    window.VOICE_ASSISTANT_CONFIG?.backendUrl || "";

  // Production Render backend.
  const productionBackend =
    "https://low-latency-ai-voice-assistant-with-rag.onrender.com";

  const sameOriginBackend =
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost:8090";

  const defaultBackend =
    configuredBackend ||
    (
      window.location.hostname.endsWith("vercel.app")
        ? productionBackend
        : sameOriginBackend
    );

  const defaultWsUrl =
    toWebSocketUrl(defaultBackend);

  /*
   * If an old Vercel WebSocket URL was saved in localStorage,
   * automatically replace it with the production Render relay.
   */

  const savedWsUrl =
    (s.wsUrl || "").trim();

  const isVercel =
    window.location.hostname.endsWith(".vercel.app");

  els.wsUrlInput.value =
    isVercel
      ? toWebSocketUrl(productionBackend)
      : (savedWsUrl || defaultWsUrl);

  els.streamModeToggle.checked =
    s.streamMode !== false;

  return s;
}

function saveSettings() {
  localStorage.setItem(
    "va_settings",
    JSON.stringify({
      wsUrl: els.wsUrlInput.value,
      streamMode: els.streamModeToggle.checked,
    })
  );
}

function toWebSocketUrl(url) {
  return url
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/$/, "");
}

// ------------------------------------------------------------
// STATUS
// ------------------------------------------------------------

function setStatus(kind, text) {
  els.statusDot.className =
    `dot ${kind}`;

  els.statusText.textContent =
    text;
}

// ------------------------------------------------------------
// TRANSCRIPT RENDERING
// ------------------------------------------------------------

function renderTurn(
  role,
  content,
  { partial = false, turnKey } = {}
) {
  const existing =
    turnKey
      ? els.transcriptPane.querySelector(
          `[data-turn-key="${turnKey}"]`
        )
      : null;

  const placeholder =
    els.transcriptPane.querySelector(
      ".placeholder"
    );

  if (placeholder) {
    placeholder.remove();
  }

  if (existing) {
    existing.querySelector(
      ".content"
    ).textContent = content;

    existing.classList.toggle(
      "partial",
      partial
    );

    return existing;
  }

  const div =
    document.createElement("div");

  div.className =
    `turn ${role}${partial ? " partial" : ""}`;

  if (turnKey) {
    div.dataset.turnKey =
      turnKey;
  }

  div.innerHTML =
    `<div class="role">${
      role === "user"
        ? "You"
        : "Assistant"
    }</div>` +
    `<div class="content"></div>`;

  div.querySelector(
    ".content"
  ).textContent = content;

  els.transcriptPane.appendChild(
    div
  );

  els.transcriptPane.scrollTop =
    els.transcriptPane.scrollHeight;

  return div;
}

// ------------------------------------------------------------
// RELAY / N8N CONNECTION
// ------------------------------------------------------------

function connectRelay() {
  const url =
    els.wsUrlInput.value.trim();

  if (!url) {
    setStatus(
      "error",
      "Relay URL is missing"
    );

    return;
  }

  console.log(
    "Connecting to relay:",
    url
  );

  const ws =
    new WebSocket(url);

  ws.onopen = () => {
    console.log(
      "Relay WebSocket connected"
    );

    setStatus(
      "idle",
      "Connected — ready"
    );
  };

  ws.onclose = () => {
    console.log(
      "Relay WebSocket disconnected"
    );

    if (!state.recording) {
      setStatus(
        "error",
        "Relay disconnected"
      );
    }
  };

  ws.onerror = (err) => {
    console.error(
      "Relay WebSocket error:",
      err
    );

    setStatus(
      "error",
      "Relay connection error"
    );
  };

  ws.onmessage = (evt) => {
    try {
      const msg =
        JSON.parse(
          evt.data
        );

      handleRelayMessage(msg);
    } catch (err) {
      console.error(
        "Invalid relay message:",
        err
      );
    }
  };

  state.relayWs =
    ws;
}

// ------------------------------------------------------------
// RELAY MESSAGE HANDLER
// ------------------------------------------------------------

function handleRelayMessage(msg) {
  /*
   * Ignore stale turn messages.
   */
  if (
    state.turnId &&
    msg.turnId &&
    msg.turnId !== state.turnId &&
    msg.type !== "error"
  ) {
    console.warn(
      `Ignoring stale message for superseded turn ` +
      `${msg.turnId} (current: ${state.turnId})`
    );

    return;
  }

  // ----------------------------------------------------------
  // LLM TEXT
  // ----------------------------------------------------------

  if (
    msg.type === "llm_token"
  ) {
    const key =
      `assistant-${msg.turnId}`;

    const current =
      (
        state.streamingAssistantText ||
        ""
      ) +
      (msg.text || "");

    state.streamingAssistantText =
      current;

    renderTurn(
      "assistant",
      current,
      {
        partial: true,
        turnKey: key,
      }
    );

    return;
  }

  // ----------------------------------------------------------
  // TTS AUDIO
  // ----------------------------------------------------------

  if (
    msg.type === "tts_chunk"
  ) {
    if (
      state.firstAudioByteTs === null
    ) {
      state.firstAudioByteTs =
        performance.now();

      const latencyMs =
        Math.round(
          state.firstAudioByteTs -
          state.turnStartTs
        );

      showLatency(
        latencyMs
      );

      setStatus(
        "speaking",
        "Speaking…"
      );
    }

    enqueueAudioChunk(
      msg.audio_b64,
      msg.seq
    );

    return;
  }

  // ----------------------------------------------------------
  // TURN COMPLETE
  // ----------------------------------------------------------

  if (
    msg.type === "done"
  ) {
    const key =
      `assistant-${msg.turnId}`;

    const el =
      els.transcriptPane.querySelector(
        `[data-turn-key="${key}"]`
      );

    if (el) {
      el.classList.remove(
        "partial"
      );
    }

    state.streamingAssistantText =
      "";

    setStatus(
      "idle",
      "Ready"
    );

    return;
  }

  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  if (
    msg.type === "error"
  ) {
    console.error(
      "Relay/n8n error:",
      msg.message
    );

    setStatus(
      "error",
      msg.message ||
        "Assistant error"
    );
  }
}

// ------------------------------------------------------------
// LATENCY
// ------------------------------------------------------------

function showLatency(ms) {
  els.latencyBadge.hidden =
    false;

  els.latencyBadge.textContent =
    `first audio: ${ms} ms`;

  els.latencyBadge.style.color =
    ms <= 1500
      ? "#6ee7b7"
      : ms <= 2000
        ? "#fbbf24"
        : "#f87171";
}

// ------------------------------------------------------------
// AUDIO PLAYBACK
// ------------------------------------------------------------

function base64ToArrayBuffer(b64) {
  const binary =
    atob(b64);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function enqueueAudioChunk(
  audioB64,
  seq
) {
  if (!audioB64) {
    return;
  }

  if (!state.audioCtx) {
    state.audioCtx =
      new (
        window.AudioContext ||
        window.webkitAudioContext
      )();
  }

  const arrayBuf =
    base64ToArrayBuffer(
      audioB64
    );

  try {
    const audioBuffer =
      await state.audioCtx.decodeAudioData(
        arrayBuf
      );

    const source =
      state.audioCtx.createBufferSource();

    source.buffer =
      audioBuffer;

    source.connect(
      state.audioCtx.destination
    );

    const now =
      state.audioCtx.currentTime;

    const startAt =
      Math.max(
        now,
        state.playback.nextStartTime
      );

    source.start(
      startAt
    );

    state.playback.nextStartTime =
      startAt +
      audioBuffer.duration;
  } catch (err) {
    console.error(
      `Failed to decode TTS chunk seq=${seq}:`,
      err
    );
  }
}

function stopPlayback() {
  /*
   * Barge-in:
   * immediately stop assistant audio when
   * the user starts speaking again.
   */
  if (state.audioCtx) {
    try {
      state.audioCtx.close();
    } catch (err) {
      console.warn(
        "AudioContext close failed:",
        err
      );
    }

    state.audioCtx =
      null;
  }

  state.playback = {
    queue: [],
    playing: false,
    nextStartTime: 0,
  };
}

// ------------------------------------------------------------
// MIC CAPTURE
// ------------------------------------------------------------

async function startRecording() {
  if (state.recording) {
    return;
  }

  try {
    state.mediaStream =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: {
            channelCount: 1,
            sampleRate: 16000,
          },
        }
      );

    /*
     * Connect STT relay BEFORE starting audio processing.
     */
    connectSttStream();

    const ctx =
      new AudioContext({
        sampleRate: 16000,
      });

    state.audioCtx =
      state.audioCtx || null;

    const source =
      ctx.createMediaStreamSource(
        state.mediaStream
      );

    /*
     * ScriptProcessorNode is used for compatibility
     * with the current browser implementation.
     *
     * 2048 reduces audio buffering latency compared
     * with the previous 4096-frame buffer.
     */
    const processor =
      ctx.createScriptProcessor(
        1024,
        1,
        1
      );

    source.connect(
      processor
    );

    processor.connect(
      ctx.destination
    );

    processor.onaudioprocess =
      (e) => {
        if (
          state.sttWs &&
          state.sttWs.readyState ===
            WebSocket.OPEN &&
          state.sttReady
        ) {
          const pcm16 =
            floatTo16BitPCM(
              e.inputBuffer
                .getChannelData(0)
            );

          state.sttWs.send(
            pcm16
          );
        }
      };

    state.processorNode =
      processor;

    state.recording =
      true;

    els.micBtn.textContent =
      "⏹️ Stop";

    els.micBtn.classList.add(
      "recording"
    );

    setStatus(
      "listening",
      "Connecting STT…"
    );
  } catch (err) {
    console.error(
      "Microphone error:",
      err
    );

    stopRecording();

    setStatus(
      "error",
      `mic error: ${err.message}`
    );
  }
}

// ------------------------------------------------------------
// PCM CONVERSION
// ------------------------------------------------------------

function floatTo16BitPCM(
  float32Array
) {
  const buf =
    new ArrayBuffer(
      float32Array.length * 2
    );

  const view =
    new DataView(buf);

  for (
    let i = 0;
    i < float32Array.length;
    i++
  ) {
    const s =
      Math.max(
        -1,
        Math.min(
          1,
          float32Array[i]
        )
      );

    view.setInt16(
      i * 2,
      s < 0
        ? s * 0x8000
        : s * 0x7fff,
      true
    );
  }

  return buf;
}

// ------------------------------------------------------------
// SARVAM STT THROUGH BACKEND RELAY
// ------------------------------------------------------------

function connectSttStream() {
  /*
   * IMPORTANT:
   *
   * The browser no longer connects directly to:
   *
   * wss://api.sarvam.ai/speech-to-text/ws
   *
   * Instead:
   *
   * Browser
   *   -> wss://low-latency-ai-voice-assistant-with-rag.onrender.com/stt
   *   -> backend relay
   *   -> Sarvam
   *
   * This keeps the API key server-side.
   */

  const relayUrl =
    els.wsUrlInput.value
      .trim()
      .replace(/\/$/, "");

  if (!relayUrl) {
    setStatus(
      "error",
      "Relay URL is missing"
    );

    return;
  }

  /*
   * The Settings field must contain only:
   *
   * wss://low-latency-ai-voice-assistant-with-rag.onrender.com
   *
   * /stt is appended automatically here.
   */
  const sttUrl =
    `${relayUrl}/stt`;

  console.log(
    "Connecting to STT relay:",
    sttUrl
  );

  state.sttReady =
    false;

  const ws =
    new WebSocket(
      sttUrl
    );

  state.sttWs =
    ws;

  ws.binaryType =
    "arraybuffer";

  // ----------------------------------------------------------
  // OPEN
  // ----------------------------------------------------------

  ws.onopen = () => {
    console.log(
      "STT relay WebSocket connected"
    );
  };

  // ----------------------------------------------------------
  // MESSAGE
  // ----------------------------------------------------------

  ws.onmessage =
    (evt) => {
      try {
        const data =
          JSON.parse(
            evt.data
          );

        console.log(
          "STT message:",
          data
        );

        // ----------------------------------------------------
        // BACKEND READY
        // ----------------------------------------------------

        if (
          data.type ===
          "stt_ready"
        ) {
          state.sttReady =
            true;

          setStatus(
            "listening",
            "Listening…"
          );

          return;
        }

        // ----------------------------------------------------
        // STT ERROR
        // ----------------------------------------------------

        if (
          data.type ===
          "stt_error"
        ) {
          state.sttReady =
            false;

          console.error(
            "STT error:",
            data.message
          );

          setStatus(
            "error",
            `STT error: ${
              data.message ||
              "unknown error"
            }`
          );

          return;
        }

        // ----------------------------------------------------
        // STT CLOSED
        // ----------------------------------------------------

        if (
          data.type ===
          "stt_closed"
        ) {
          state.sttReady =
            false;

          console.warn(
            "STT relay closed:",
            data.code
          );

          if (
            state.recording
          ) {
            setStatus(
              "error",
              "STT disconnected"
            );
          }

          return;
        }

        // ----------------------------------------------------
        // SARVAM TRANSCRIPT
        // ----------------------------------------------------
        //
        // Current Sarvam response:
        //
        // {
        //   type: "data",
        //   data: {
        //     transcript: "hello"
        //   }
        // }
        //
        // ----------------------------------------------------

        if (
          data.type ===
            "data" &&
          data.data
        ) {
          const transcript =
            (
              data.data.transcript ||
              ""
            ).trim();

          if (
            transcript
          ) {
            console.log(
              "Transcript:",
              transcript
            );

            /*
             * Sarvam can send multiple transcript
             * updates for the same utterance.
             *
             * Do NOT immediately send every update.
             * onSttResult() debounces them and sends
             * only the latest transcript after silence.
             */
            onSttResult(
              transcript,
              false
            );
          }

          return;
        }

        // ----------------------------------------------------
        // COMPATIBILITY WITH OLDER RESPONSE FORMAT
        // ----------------------------------------------------

        if (
          data.transcript
        ) {
          onSttResult(
            data.transcript,
            !!data.is_final
          );
        }
      } catch (err) {
        console.error(
          "Invalid STT message:",
          err
        );
      }
    };

  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  ws.onerror =
    (err) => {
      console.error(
        "STT WebSocket error:",
        err
      );

      state.sttReady =
        false;

      setStatus(
        "error",
        "STT connection error"
      );
    };

  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  ws.onclose =
    (event) => {
      console.log(
        "STT relay disconnected:",
        event.code,
        event.reason
      );

      state.sttReady =
        false;

      state.sttWs =
        null;

      if (
        state.recording
      ) {
        setStatus(
          "error",
          "STT disconnected"
        );
      }
    };
}

// ------------------------------------------------------------
// STT RESULT
// ------------------------------------------------------------

function onSttResult(
  transcript,
  isFinal
) {
  const cleanText =
    (transcript || "").trim();

  if (!cleanText) {
    return;
  }

  /*
   * Any new speech interrupts assistant playback.
   */
  stopPlayback();

  state.lastPartial =
    cleanText;

  /*
   * Always keep the newest transcript.
   * This prevents an earlier partial transcript
   * from being sent when a newer one has arrived.
   */
  state.pendingTranscript =
    cleanText;

  renderTurn(
    "user",
    cleanText,
    {
      partial: !isFinal,
      turnKey: "user-current",
    }
  );

  clearTimeout(
    state.silenceTimer
  );

  /*
   * If the STT provider explicitly marks
   * the transcript as final, send immediately.
   */
  if (isFinal) {
    state.pendingTranscript =
      "";

    sendTranscriptTurn(
      cleanText,
      true
    );

    return;
  }

  /*
   * Debounce partial transcripts.
   *
   * Sarvam may emit:
   *
   *   "Hello"
   *   "Hello hello"
   *   "Hello hello how"
   *   "Hello hello how are you"
   *
   * We wait until the user stops speaking,
   * then send only the latest transcript.
   */
  state.silenceTimer =
    setTimeout(
      () => {
        const latest =
          state.pendingTranscript.trim();

        if (!latest) {
          return;
        }

        state.pendingTranscript =
          "";

        sendTranscriptTurn(
          latest,
          false
        );
      },
      SILENCE_MS
    );
}

// ------------------------------------------------------------
// SEND TRANSCRIPT TO N8N
// ------------------------------------------------------------

function sendTranscriptTurn(
  text,
  isFinal
) {
  const cleanText =
    (text || "").trim();

  if (
    !state.relayWs ||
    state.relayWs.readyState !==
      WebSocket.OPEN
  ) {
    setStatus(
      "error",
      "Not connected to relay"
    );

    return;
  }

  if (!cleanText) {
    return;
  }

  /*
   * Prevent duplicate turns.
   *
   * This is important because Sarvam can emit
   * both partial and final transcript messages.
   */
  if (
    cleanText ===
    state.lastSentText
  ) {
    console.warn(
      "Duplicate transcript ignored:",
      cleanText
    );

    return;
  }

  state.lastSentText =
    cleanText;

  /*
   * Create a unique turn ID.
   *
   * The backend uses this ID to associate
   * n8n callbacks with the correct browser
   * WebSocket connection.
   */
  state.turnId =
    `${Date.now()}-` +
    `${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  state.turnStartTs =
    performance.now();

  state.firstAudioByteTs =
    null;

  state.streamingAssistantText =
    "";

  console.log(
    `[${state.turnId}] Sending transcript to relay:`,
    cleanText
  );

  setStatus(
    "processing",
    "Thinking…"
  );

  /*
   * Convert the current user transcript
   * from partial -> final in the UI.
   */
  const finalEl =
    els.transcriptPane.querySelector(
      '[data-turn-key="user-current"]'
    );

  if (finalEl) {
    finalEl.removeAttribute(
      "data-turn-key"
    );

    finalEl.classList.remove(
      "partial"
    );
  }

  /*
   * Send transcript to backend relay.
   *
   * The backend then forwards it to n8n.
   */
  state.relayWs.send(
    JSON.stringify({
      type: "transcript",
      text: cleanText,
      isFinal,
      turnId:
        state.turnId,
    })
  );
}

// ------------------------------------------------------------
// STOP RECORDING
// ------------------------------------------------------------

function stopRecording() {
  state.recording =
    false;

  state.sttReady =
    false;

  clearTimeout(
    state.silenceTimer
  );

  state.silenceTimer =
    null;

  state.pendingTranscript =
    "";

  els.micBtn.textContent =
    "🎙️ Start Talking";

  els.micBtn.classList.remove(
    "recording"
  );

  if (
    state.processorNode
  ) {
    try {
      state.processorNode.disconnect();
    } catch (err) {
      console.warn(
        "Processor disconnect failed:",
        err
      );
    }

    state.processorNode =
      null;
  }

  if (
    state.mediaStream
  ) {
    state.mediaStream
      .getTracks()
      .forEach(
        (track) =>
          track.stop()
      );

    state.mediaStream =
      null;
  }

  if (
    state.sttWs
  ) {
    try {
      state.sttWs.close();
    } catch (err) {
      console.warn(
        "STT close failed:",
        err
      );
    }

    state.sttWs =
      null;
  }

  setStatus(
    "idle",
    "Idle"
  );
}

// ------------------------------------------------------------
// UI WIRING
// ------------------------------------------------------------

els.micBtn.addEventListener(
  "click",
  () => {
    if (
      !state.recording
    ) {
      startRecording();
    } else {
      stopRecording();
    }
  }
);

els.settingsBtn.addEventListener(
  "click",
  () => {
    els.settingsDialog.showModal();
  }
);

els.settingsDialog
  .querySelector(
    "#saveSettingsBtn"
  )
  .addEventListener(
    "click",
    () => {
      saveSettings();

      if (
        state.relayWs
      ) {
        state.relayWs.close();
      }

      connectRelay();
    }
  );

// ------------------------------------------------------------
// INITIALIZATION
// ------------------------------------------------------------

loadSettings();
connectRelay();