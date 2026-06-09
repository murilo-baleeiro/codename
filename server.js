const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// ─── Game State ───────────────────────────────────────────────────────────────
let gameState = {
  words: [],
  started: false,
  scores: { green: 0, blue: 0 },
  gameOver: false,
  winner: null,
};

// Words used in the last game — avoided in the next shuffle
let lastUsedWords = [];

// Active rooms: roomId -> { tv: Set<ws>, master: ws|null }
const rooms = new Map();

// ─── Load words from palavras.txt ─────────────────────────────────────────────
function loadWords() {
  const filePath = path.join(__dirname, "palavras.txt");
  if (!fs.existsSync(filePath)) {
    console.warn("[AVISO] palavras.txt não encontrado. Usando palavras de exemplo.");
    return [
      "ESTRELA","OCEANO","FLORESTA","MONTANHA","DESERTO",
      "CASTELO","ESPADA","DRAGÃO","TESOURO","PORTAL",
      "NUVEM","RELÂMPAGO","VULCÃO","DIAMANTE","ORÁCULO",
      "SOMBRA","ESPELHO","LABIRINTO","FANTASMA","CRISTAL",
      "TROVÃO","SERPENTE","ARCO","TOCHA","BARCO",
      "PEDRA","VENTO","CHAMA","GELO","MAPA",
      "COROA","PUNHAL","ANEL","CÁLICE","FEITIÇO",
      "CAPITÃO","NAVE","PLANETA","NEBULOSA","COMETA",
      "MÁSCARA","VÉU","LANTERNA","BÚSSOLA","ÂNCORA",
      "RADAR","CÓDIGO","SENHA","AGENTE","MISSÃO",
    ];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length > 0);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newGame() {
  const allWords = loadWords();
  if (allWords.length < 25) {
    console.error("[ERRO] palavras.txt precisa ter ao menos 25 palavras.");
    process.exit(1);
  }

  const freshWords = shuffleArray(
    allWords.filter((w) => !lastUsedWords.includes(w)),
  );
  const reusable = shuffleArray(
    allWords.filter((w) => lastUsedWords.includes(w)),
  );
  const picked = [...freshWords, ...reusable].slice(0, 25);

  lastUsedWords = picked.slice();

  const colors = [
    ...Array(10).fill("green"),
    ...Array(10).fill("blue"),
    ...Array(4).fill("gray"),
    "black",
  ];
  const shuffledColors = shuffleArray(colors);

  gameState = {
    words: picked.map((word, i) => ({
      word,
      color: shuffledColors[i],
      revealed: false,
    })),
    started: true,
    scores: { green: 0, blue: 0 },
    gameOver: false,
    winner: null,
  };

  broadcast({ type: "gameState", data: gameState });
  console.log("[JOGO] Novo jogo iniciado.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendToRoom(roomId, msg, exclude) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  room.tv.forEach((tv) => {
    if (tv !== exclude && tv.readyState === WebSocket.OPEN) {
      tv.send(payload);
    }
  });
  if (room.master && room.master !== exclude && room.master.readyState === WebSocket.OPEN) {
    room.master.send(payload);
  }
}

function startGameForRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameStarted) return; // Prevent double start
  room.gameStarted = true;
  newGame();
  sendToRoom(roomId, { type: "gameStarting", room: roomId });
}

function bothReady(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // Notify TV that master is connected (with a short delay for UX)
  sendToRoom(roomId, { type: "masterConnected", room: roomId });
  // After 2 seconds, start the game and redirect TV
  setTimeout(() => startGameForRoom(roomId), 2000);
}

// Clean up disconnected clients from rooms
function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.tv.forEach((tv) => {
    if (tv.readyState !== WebSocket.OPEN) room.tv.delete(tv);
  });
  if (room.master && room.master.readyState !== WebSocket.OPEN) {
    room.master = null;
  }
  if (room.tv.size === 0 && !room.master && !room.httpMaster) {
    rooms.delete(roomId);
    console.log(`[SALA] Sala ${roomId} removida (vazia).`);
  }
}

function getLanIps() {
  const os = require("os");
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === "IPv4" && !n.internal) {
        ips.push({ name, address: n.address });
      }
    }
  }
  return ips;
}

function getLanIp() {
  const ips = getLanIps();
  // Prefer common LAN ranges (192.168.x.x, 10.x.x.x)
  const preferred = ips.find((i) =>
    i.address.startsWith("192.168.") || i.address.startsWith("10."),
  );
  return preferred ? preferred.address : (ips[0] ? ips[0].address : "localhost");
}

// ─── Server start time for health checks ──────────────────────────────────────
const serverStartTime = Date.now();

// ─── Health check endpoint ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  var roomList = [];
  rooms.forEach(function (room, roomId) {
      roomList.push({
        room: roomId,
        tv: room.tv.size,
        master: room.master ? true : false,
        httpMaster: room.httpMaster || false,
      });
  });
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    connections: wss.clients.size,
    rooms: rooms.size,
    roomList: roomList,
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  var clientIp = req.socket.remoteAddress || "unknown";
  console.log("[WS] Cliente conectado de " + clientIp + ". Total: " + wss.clients.size);

  ws.send(JSON.stringify({ type: "gameState", data: gameState }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // ── Room management ───────────────────────────────────
    if (msg.type === "joinRoom") {
      const { room: roomId, role } = msg;
      if (!roomId || !role) return;

      // Ensure room exists
      if (!rooms.has(roomId)) {
        rooms.set(roomId, { tv: new Set(), master: null, httpMaster: false, gameStarted: false });
      }
      const room = rooms.get(roomId);

      if (role === "tv") {
        room.tv.add(ws);
        ws.roomRole = "tv";
        ws.roomId = roomId;
        sendTo(ws, { type: "roomJoined", room: roomId });
        console.log(`[SALA] TV entrou na sala ${roomId}`);

        // If master is already in the room (WebSocket or HTTP), notify TV
        if (room.master && room.master.readyState === WebSocket.OPEN) {
          console.log(`[SALA] Mestre já presente na sala ${roomId}. Iniciando jogo...`);
          bothReady(roomId);
        } else if (room.httpMaster && gameState.started) {
          // HTTP master already paired and game running — send game starting to TV
          console.log(`[SALA] Mestre HTTP já presente na sala ${roomId}. Jogo já iniciado.`);
          sendTo(ws, { type: "gameStarting", room: roomId });
        } else if (room.httpMaster) {
          // HTTP master paired but game hasn't started yet — start it now
          console.log(`[SALA] Mestre HTTP presente na sala ${roomId}. Iniciando jogo...`);
          sendTo(ws, { type: "masterConnected", room: roomId });
          setTimeout(() => startGameForRoom(roomId), 2000);
        }
      } else if (role === "master") {
        // If there's already a master in this room, reject
        if (room.master && room.master.readyState === WebSocket.OPEN) {
          sendTo(ws, { type: "roomError", message: "Já existe um mestre conectado a esta sala." });
          return;
        }
        room.master = ws;
        ws.roomRole = "master";
        ws.roomId = roomId;
        sendTo(ws, { type: "roomJoined", room: roomId });
        console.log(`[SALA] Mestre entrou na sala ${roomId}`);

        // If TV is already in the room, both are ready → start game
        if (room.tv.size > 0) {
          console.log(`[SALA] TV já presente na sala ${roomId}. Iniciando jogo...`);
          bothReady(roomId);
        }
      }
      return;
    }

    // ── Start Game ────────────────────────────────────────
    if (msg.type === "startGame") {
      const { room: roomId } = msg;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.tv.size === 0) return;

      startGameForRoom(roomId);
      return;
    }

    // ── Reveal word ───────────────────────────────────────
    if (msg.type === "revealWord") {
      const { index } = msg;
      if (!gameState.started || gameState.gameOver) return;
      if (index < 0 || index >= gameState.words.length) return;
      const entry = gameState.words[index];
      if (entry.revealed) return;

      entry.revealed = true;

      if (entry.color === "green") gameState.scores.green++;
      else if (entry.color === "blue") gameState.scores.blue++;

      if (entry.color === "black") {
        gameState.gameOver = true;
        gameState.winner = "none";
      }

      const greens = gameState.words.filter((w) => w.color === "green");
      const blues = gameState.words.filter((w) => w.color === "blue");
      if (!gameState.gameOver) {
        if (greens.every((w) => w.revealed)) {
          gameState.gameOver = true;
          gameState.winner = "green";
        } else if (blues.every((w) => w.revealed)) {
          gameState.gameOver = true;
          gameState.winner = "blue";
        }
      }

      broadcast({ type: "gameState", data: gameState });
      console.log(`[JOGO] Palavra revelada: "${entry.word}" (${entry.color})`);
    }

    // ── New Game ──────────────────────────────────────────
    if (msg.type === "newGame") {
      newGame();
    }
  });

  ws.on("close", () => {
    console.log("[WS] Cliente desconectado.");
    // Clean up room membership
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        if (ws.roomRole === "tv") {
          room.tv.delete(ws);
        } else if (ws.roomRole === "master") {
          room.master = null;
          // Notify TVs that master disconnected
          sendToRoom(ws.roomId, { type: "masterDisconnected", room: ws.roomId });
        }
        cleanupRoom(ws.roomId);
      }
    }
  });
});

// ─── Server-side Pairing (works even without JavaScript on phone) ────────────
app.get("/pair/:roomId", (req, res) => {
  var roomId = req.params.roomId;
  if (!roomId) return res.status(400).send("Código de sala inválido");

  if (!rooms.has(roomId)) {
    rooms.set(roomId, { tv: new Set(), master: null, httpMaster: false, gameStarted: false });
  }
  var room = rooms.get(roomId);

  if (!room.httpMaster) {
    room.httpMaster = true;
    console.log("[PAIR] Celular pareado via servidor na sala " + roomId);

    if (room.tv.size > 0) {
      console.log("[PAIR] TV presente. Iniciando jogo...");
      sendToRoom(roomId, { type: "masterConnected", room: roomId });
      setTimeout(function () {
        var r = rooms.get(roomId);
        if (r && r.tv.size > 0) {
          r.gameStarted = true;
          newGame();
          sendToRoom(roomId, { type: "gameStarting", room: roomId });
        }
      }, 2000);
    }
  }

  res.send(
    '<!doctype html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CODENAME — Conectado</title>' +
    '<style>body{background:#faf8f3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}' +
    '.card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 8px 30px rgba(0,0,0,0.08);max-width:360px}' +
    'h1{font-size:28px;letter-spacing:2px;text-transform:uppercase;color:#1c1c1e;margin:0 0 8px}' +
    'p{color:#666;font-size:15px;margin:0 0 20px;line-height:1.5}' +
    '.btn{display:inline-block;background:#1c1c1e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;letter-spacing:1px;text-transform:uppercase}' +
    '.btn:hover{background:#333}</style>' +
    '</head><body>' +
    '<div class="card">' +
    '<h1>✅ Conectado!</h1>' +
    '<p>Seu celular foi pareado com a sala <strong>' + roomId + '</strong>.<br>' +
    'O jogo iniciará automaticamente no telão.</p>' +
    '<a class="btn" href="/mestre?room=' + roomId + '">Abrir Painel do Mestre</a>' +
    '</div></body></html>'
  );
});

// ─── HTTP Fallback (for phones that can't use WebSocket) ──────────────────────
app.post("/api/pair-room", (req, res) => {
  var roomId = req.body && req.body.room;
  if (!roomId) return res.status(400).json({ error: "room required" });

  if (!rooms.has(roomId)) {
    rooms.set(roomId, { tv: new Set(), master: null, httpMaster: false, gameStarted: false });
  }
  var room = rooms.get(roomId);

  if (room.httpMaster) {
    // Already paired — return ok so client can proceed
    console.log("[HTTP] POST /api/pair-room sala " + roomId + " já pareada (httpMaster=true)");
    return res.json({ ok: true, room: roomId, tvConnected: room.tv.size > 0, alreadyPaired: true });
  }

  room.httpMaster = true;
  console.log("[HTTP] POST /api/pair-room mestre conectado via HTTP na sala " + roomId);

  // Start game if TV is present
  if (room.tv.size > 0) {
    console.log("[HTTP] POST /api/pair-room TV já presente. Iniciando jogo em 2s...");
    sendToRoom(roomId, { type: "masterConnected", room: roomId });
    setTimeout(function () {
      var r = rooms.get(roomId);
      if (r && r.tv.size > 0) {
        r.gameStarted = true;
        newGame();
        sendToRoom(roomId, { type: "gameStarting", room: roomId });
      }
    }, 2000);
  }

  res.json({ ok: true, room: roomId, tvConnected: room.tv.size > 0 });
});

app.get("/api/game-state", (req, res) => {
  var clientIp = req.ip || req.socket.remoteAddress || "unknown";
  console.log("[HTTP] GET /api/game-state de " + clientIp + " — started=" + gameState.started + " words=" + (gameState.words ? gameState.words.length : 0));
  res.json(gameState);
});

app.post("/api/reveal-word", (req, res) => {
  var index = req.body && req.body.index;
  if (typeof index !== "number") return res.status(400).json({ error: "index required" });
  if (!gameState.started || gameState.gameOver) return res.status(400).json({ error: "Jogo não ativo" });
  if (index < 0 || index >= gameState.words.length) return res.status(400).json({ error: "Índice inválido" });

  var entry = gameState.words[index];
  if (entry.revealed) return res.status(400).json({ error: "Palavra já revelada" });

  entry.revealed = true;
  if (entry.color === "green") gameState.scores.green++;
  else if (entry.color === "blue") gameState.scores.blue++;

  if (entry.color === "black") {
    gameState.gameOver = true;
    gameState.winner = "none";
  }

  var greens = gameState.words.filter(function (w) { return w.color === "green"; });
  var blues = gameState.words.filter(function (w) { return w.color === "blue"; });
  if (!gameState.gameOver) {
    if (greens.every(function (w) { return w.revealed; })) {
      gameState.gameOver = true;
      gameState.winner = "green";
    } else if (blues.every(function (w) { return w.revealed; })) {
      gameState.gameOver = true;
      gameState.winner = "blue";
    }
  }

  broadcast({ type: "gameState", data: gameState });
  console.log("[HTTP] Palavra revelada via HTTP: \"" + entry.word + "\" (" + entry.color + ")");
  res.json({ ok: true, gameState: gameState });
});

app.post("/api/new-game", (req, res) => {
  newGame();
  res.json({ ok: true });
});

// ─── QR Code API ──────────────────────────────────────────────────────────────
app.get("/api/qr", async (req, res) => {
  const roomId = req.query.room;
  if (!roomId) return res.status(400).json({ error: "room parameter required" });

  const allIps = getLanIps();
  const primaryIp = getLanIp();
  const urls = [];
  // Always include localhost
  urls.push(`http://localhost:${PORT}/pair/${roomId}`);
  // Include each LAN IP
  for (const ip of allIps) {
    urls.push(`http://${ip.address}:${PORT}/pair/${roomId}`);
  }
  const primaryUrl = `http://${primaryIp}:${PORT}/pair/${roomId}`;
  try {
    const qr = await QRCode.toDataURL(primaryUrl, { width: 400, margin: 2, color: { dark: "#1c1c1e", light: "#ffffff" } });
    res.json({ qr, url: primaryUrl, room: roomId, urls });
  } catch (err) {
    res.status(500).json({ error: "Falha ao gerar QR Code" });
  }
});

// ─── PWA static files ─────────────────────────────────────────────────────────
const PWA_FILES = ["manifest.json", "sw.js", "icon-192.svg", "icon-512.svg"];
PWA_FILES.forEach((f) => {
  app.get(`/${f}`, (req, res) =>
    res.sendFile(path.join(__dirname, f)),
  );
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "index.html")),
);
app.get("/mestre", (req, res) => {
  var clientIp = req.ip || req.socket.remoteAddress || "unknown";
  console.log("[HTTP] GET /mestre de " + clientIp + " room=" + (req.query.room || "none"));
  res.sendFile(path.join(__dirname, "mestre.html"));
});
app.get("/palavras", (req, res) =>
  res.sendFile(path.join(__dirname, "palavras.html")),
);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const os = require("os");
  const nets = os.networkInterfaces();
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║           CODENAME - Servidor Ativo           ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  Local:  http://localhost:${PORT}                ║`);
  Object.values(nets)
    .flat()
    .forEach((n) => {
      if (n.family === "IPv4" && !n.internal) {
        const ip = `http://${n.address}:${PORT}`;
        console.log(`║  Rede:   ${ip.padEnd(36)}║`);
      }
    });
  console.log("╠══════════════════════════════════════════════╣");
  console.log("║  Abra http://localhost:" + PORT.toString().padEnd(3) + " no telão         ║");
  console.log("║  para escanear o QR Code com o celular       ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
