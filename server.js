const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
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

// ─── Load words from palavras.txt ─────────────────────────────────────────────
function loadWords() {
  const filePath = path.join(__dirname, "palavras.txt");
  if (!fs.existsSync(filePath)) {
    console.warn(
      "[AVISO] palavras.txt não encontrado. Usando palavras de exemplo.",
    );
    return [
      "ESTRELA",
      "OCEANO",
      "FLORESTA",
      "MONTANHA",
      "DESERTO",
      "CASTELO",
      "ESPADA",
      "DRAGÃO",
      "TESOURO",
      "PORTAL",
      "NUVEM",
      "RELÂMPAGO",
      "VULCÃO",
      "DIAMANTE",
      "ORÁCULO",
      "SOMBRA",
      "ESPELHO",
      "LABIRINTO",
      "FANTASMA",
      "CRISTAL",
      "TROVÃO",
      "SERPENTE",
      "ARCO",
      "TOCHA",
      "BARCO",
      "PEDRA",
      "VENTO",
      "CHAMA",
      "GELO",
      "MAPA",
      "COROA",
      "PUNHAL",
      "ANEL",
      "CÁLICE",
      "FEITIÇO",
      "CAPITÃO",
      "NAVE",
      "PLANETA",
      "NEBULOSA",
      "COMETA",
      "MÁSCARA",
      "VÉU",
      "LANTERNA",
      "BÚSSOLA",
      "ÂNCORA",
      "RADAR",
      "CÓDIGO",
      "SENHA",
      "AGENTE",
      "MISSÃO",
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

  // Prioritize words NOT used in the last game to maximize variety
  const freshWords = shuffleArray(
    allWords.filter((w) => !lastUsedWords.includes(w)),
  );
  const reusable = shuffleArray(
    allWords.filter((w) => lastUsedWords.includes(w)),
  );
  const picked = [...freshWords, ...reusable].slice(0, 25);

  // Remember this round's words for next time
  lastUsedWords = picked.slice();

  // Assign colors: 10 green, 10 blue, 4 gray, 1 black
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

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("[WS] Cliente conectado.");

  ws.send(JSON.stringify({ type: "gameState", data: gameState }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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

    if (msg.type === "newGame") {
      newGame();
    }
  });

  ws.on("close", () => console.log("[WS] Cliente desconectado."));
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/palavras"));
app.get("/mestre", (req, res) =>
  res.sendFile(path.join(__dirname, "mestre.html")),
);
app.get("/palavras", (req, res) =>
  res.sendFile(path.join(__dirname, "palavras.html")),
);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  newGame();
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
  console.log("║  /mestre  → Tela dos Mestres                  ║");
  console.log("║  /palavras → Tela dos Jogadores               ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
