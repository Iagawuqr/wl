const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const kill = require("tree-kill");
const http = require("http");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 8000;

// ─── DDoS Protection: Rate Limiting ───
const rateLimitStore = new Map();
const RATE_LIMITS = {
  global: { max: 100, windowMs: 60000 },
  exec: { max: 10, windowMs: 60000 },
  deploy: { max: 5, windowMs: 60000 },
  admin: { max: 10, windowMs: 60000 },
};

function rateLimit(category = "global") {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const key = `${ip}:${category}`;
    const limit = RATE_LIMITS[category] || RATE_LIMITS.global;
    const now = Date.now();

    let record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + limit.windowMs };
      rateLimitStore.set(key, record);
    }

    record.count++;

    res.setHeader("X-RateLimit-Limit", limit.max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, limit.max - record.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetAt / 1000));

    if (record.count > limit.max) {
      return res.status(429).json({
        error: "Too many requests. Try again later.",
        retryAfter: Math.ceil((record.resetAt - now) / 1000),
      });
    }

    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore) {
    if (now > record.resetAt) rateLimitStore.delete(key);
  }
}, 300000);

// ─── Request Size & Slowloris Protection ───
app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(60000);
  next();
});

// ─── CORS ───
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173", "http://localhost:8080", "https://lpzxhost.lovable.app"];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".lovable.app")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));
app.use(rateLimit("global"));

const BOTS_DIR = path.join(__dirname, "bots");
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const runningBots = new Map();

// ─── JWT Authentication ───
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

function authenticate(req, res, next) {
  if (!SUPABASE_JWT_SECRET) {
    console.warn("WARNING: SUPABASE_JWT_SECRET not set. Authentication disabled.");
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.userId = decoded.sub;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
}

app.use("/bots", authenticate);
app.use("/admin", authenticate);

// ─── Health Check ───
app.get("/health", (req, res) => {
  const bots = [];
  for (const [id, info] of runningBots) {
    bots.push({ id, pid: info.process?.pid, uptime: Date.now() - info.startedAt });
  }
  res.json({
    status: "ok",
    uptime: process.uptime(),
    activeBots: runningBots.size,
    bots,
    memoryUsage: process.memoryUsage(),
  });
});

// ─── Deploy Bot (with env vars + auto-start) ───
app.post("/bots/:botId/deploy", rateLimit("deploy"), async (req, res) => {
  const { botId } = req.params;
  const { files, language, startupFile, envVars, autoStart } = req.body;

  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });

  // Write files
  for (const file of files || []) {
    const filePath = path.join(botDir, file.name);
    if (!filePath.startsWith(botDir)) {
      return res.status(400).json({ error: "Invalid file path" });
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }

  // Write .env file with environment variables
  if (envVars && typeof envVars === "object" && Object.keys(envVars).length > 0) {
    const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join("\n");
    fs.writeFileSync(path.join(botDir, ".env"), envContent);
  }

  fs.writeFileSync(
    path.join(botDir, ".botmeta.json"),
    JSON.stringify({ language, startupFile, deployedAt: new Date().toISOString(), userId: req.userId })
  );

  try {
    const hasPackageJson = fs.existsSync(path.join(botDir, "package.json"));
    const hasRequirements = fs.existsSync(path.join(botDir, "requirements.txt"));

    let installOutput = "";
    if (language === "javascript" && hasPackageJson) {
      installOutput = await runCommand("npm", ["install", "--production"], botDir);
    } else if (language === "python" && hasRequirements) {
      installOutput = await runCommand("pip", ["install", "-r", "requirements.txt", "--target", path.join(botDir, "pip_modules")], botDir);
    }

    // Auto-start bot after deploy
    if (autoStart !== false) {
      // Stop if already running
      const existing = runningBots.get(botId);
      if (existing) {
        await new Promise((resolve) => { kill(existing.process.pid, "SIGTERM", () => { runningBots.delete(botId); resolve(); }); });
      }
      
      const startResult = startBotProcess(botId, botDir, language, startupFile, envVars);
      if (startResult.error) {
        return res.json({ success: true, message: "Deploy completo, mas falhou ao iniciar: " + startResult.error, installOutput });
      }
      return res.json({ success: true, message: "Deploy completo e bot iniciado!", pid: startResult.pid, installOutput });
    }

    res.json({ success: true, message: "Deploy completo", installOutput });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start Bot (helper function) ───
function startBotProcess(botId, botDir, language, startupFile, envVars) {
  if (!fs.existsSync(botDir)) return { error: "Bot não encontrado. Faça deploy primeiro." };
  if (runningBots.has(botId)) return { error: "Bot já está rodando." };

  // Read .botmeta if language/startupFile not provided
  if (!language || !startupFile) {
    const metaPath = path.join(botDir, ".botmeta.json");
    if (!fs.existsSync(metaPath)) return { error: "Faça deploy primeiro." };
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    language = language || meta.language;
    startupFile = startupFile || meta.startupFile;
  }

  let cmd, args;
  if (language === "javascript") {
    cmd = "node"; args = [startupFile || "index.js"];
  } else {
    cmd = "python"; args = [startupFile || "main.py"];
  }

  // Build environment with env vars injected
  const BOT_ENV = {
    NODE_ENV: "production",
    BOT_ID: botId,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || "en_US.UTF-8",
  };

  // Inject env vars from .env file
  const envFilePath = path.join(botDir, ".env");
  if (fs.existsSync(envFilePath)) {
    const envContent = fs.readFileSync(envFilePath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        BOT_ENV[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  }

  // Also inject env vars passed directly
  if (envVars && typeof envVars === "object") {
    Object.assign(BOT_ENV, envVars);
  }

  if (language === "python") {
    const pipModules = path.join(botDir, "pip_modules");
    if (fs.existsSync(pipModules)) BOT_ENV.PYTHONPATH = pipModules;
  }

  const botProcess = spawn(cmd, args, {
    cwd: botDir, env: BOT_ENV, stdio: ["pipe", "pipe", "pipe"],
  });

  const logs = [];
  const startedAt = Date.now();

  botProcess.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line) {
      const entry = { timestamp: new Date().toISOString(), level: "info", message: line };
      logs.push(entry); if (logs.length > 1000) logs.shift();
      broadcastLog(botId, entry);
    }
  });

  botProcess.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) {
      const entry = { timestamp: new Date().toISOString(), level: "error", message: line };
      logs.push(entry); if (logs.length > 1000) logs.shift();
      broadcastLog(botId, entry);
    }
  });

  botProcess.on("exit", (code) => {
    const entry = { timestamp: new Date().toISOString(), level: code === 0 ? "info" : "error", message: `Processo encerrado com código ${code}` };
    logs.push(entry); broadcastLog(botId, entry);
    runningBots.delete(botId);
  });

  runningBots.set(botId, { process: botProcess, logs, startedAt });
  return { pid: botProcess.pid };
}

// ─── Start Bot (HTTP endpoint) ───
app.post("/bots/:botId/start", (req, res) => {
  const { botId } = req.params;
  const botDir = path.join(BOTS_DIR, botId);
  const { envVars } = req.body || {};

  const result = startBotProcess(botId, botDir, null, null, envVars);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, pid: result.pid });
});

// ─── Stop Bot ───
app.post("/bots/:botId/stop", (req, res) => {
  const { botId } = req.params;
  const info = runningBots.get(botId);
  if (!info) return res.status(400).json({ error: "Bot não está rodando." });
  kill(info.process.pid, "SIGTERM", (err) => {
    if (err) return res.status(500).json({ error: "Falha ao parar." });
    runningBots.delete(botId);
    res.json({ success: true });
  });
});

// ─── Restart Bot ───
app.post("/bots/:botId/restart", async (req, res) => {
  const { botId } = req.params;
  const botDir = path.join(BOTS_DIR, botId);
  const { envVars } = req.body || {};
  
  const info = runningBots.get(botId);
  if (info) {
    await new Promise((resolve) => { kill(info.process.pid, "SIGTERM", () => { runningBots.delete(botId); resolve(); }); });
  }
  
  const result = startBotProcess(botId, botDir, null, null, envVars);
  if (result.error) return res.json({ success: false, error: result.error });
  res.json({ success: true, message: "Bot reiniciado!", pid: result.pid });
});

// ─── Get Logs ───
app.get("/bots/:botId/logs", (req, res) => {
  const info = runningBots.get(req.params.botId);
  res.json({ logs: info?.logs || [] });
});

// ─── Get Status ───
app.get("/bots/:botId/status", (req, res) => {
  const info = runningBots.get(req.params.botId);
  if (!info) return res.json({ status: "stopped", memoryMb: 0 });
  let memoryMb = 0;
  try {
    const pidStatus = fs.readFileSync(`/proc/${info.process.pid}/status`, "utf-8");
    const vmRss = pidStatus.match(/VmRSS:\s+(\d+)/);
    if (vmRss) memoryMb = parseInt(vmRss[1]) / 1024;
  } catch {}
  res.json({ status: "running", pid: info.process.pid, memoryMb: Math.round(memoryMb * 100) / 100, uptime: Date.now() - info.startedAt });
});

// ─── Execute Command (with security) ───
const ALLOWED_COMMANDS = ["npm", "node", "python", "pip", "ls", "cat", "pwd", "echo", "mkdir", "cp", "mv", "rm", "touch", "head", "tail", "grep", "wc"];

app.post("/bots/:botId/exec", rateLimit("exec"), (req, res) => {
  const { botId } = req.params;
  const { command } = req.body;

  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "Command is required" });
  }

  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) return res.status(404).json({ error: "Bot não encontrado." });

  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];

  if (!ALLOWED_COMMANDS.includes(cmd)) {
    return res.status(400).json({ error: `Command not allowed: ${cmd}` });
  }

  const safeArgs = parts.slice(1).map(arg => arg.replace(/[;&|`$()<>{}!\\]/g, ""));

  let responseSent = false;

  const proc = spawn(cmd, safeArgs, {
    cwd: botDir,
    timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    shell: false,
  });

  let output = "";
  const MAX_OUTPUT = 50000;
  proc.stdout.on("data", (d) => { if (output.length < MAX_OUTPUT) output += d.toString(); });
  proc.stderr.on("data", (d) => { if (output.length < MAX_OUTPUT) output += d.toString(); });
  
  proc.on("close", (code) => {
    if (!responseSent) {
      responseSent = true;
      res.json({ output: output.trim(), exitCode: code });
    }
  });
  
  proc.on("error", (err) => {
    if (!responseSent) {
      responseSent = true;
      res.json({ output: err.message, exitCode: 1 });
    }
  });
});

// ─── Upload File ───
app.post("/bots/:botId/files", (req, res) => {
  const { botId } = req.params;
  const { fileName, content } = req.body;
  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });

  const filePath = path.join(botDir, fileName);
  if (!filePath.startsWith(botDir)) return res.status(400).json({ error: "Invalid file path" });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(filePath, content);
  res.json({ success: true });
});

// ─── List Files ───
app.get("/bots/:botId/files", (req, res) => {
  const botDir = path.join(BOTS_DIR, req.params.botId);
  if (!fs.existsSync(botDir)) return res.json({ files: [] });
  const allFiles = [];
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "pip_modules", ".botmeta.json", ".env"].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else allFiles.push({ name: rel, size: fs.statSync(path.join(dir, entry.name)).size });
    }
  }
  walk(botDir);
  res.json({ files: allFiles });
});

// ─── Delete File ───
app.delete("/bots/:botId/files/:fileName", (req, res) => {
  const { botId, fileName } = req.params;
  const botDir = path.join(BOTS_DIR, botId);
  const filePath = path.join(botDir, fileName);
  if (!filePath.startsWith(botDir)) return res.status(400).json({ error: "Invalid file path" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo não encontrado." });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ─── Stop All (admin) ───
app.post("/admin/stop-all", rateLimit("admin"), (req, res) => {
  let count = 0;
  for (const [, info] of runningBots) { kill(info.process.pid, "SIGTERM"); count++; }
  runningBots.clear();
  res.json({ success: true, stopped: count });
});

// ─── WebSocket ───
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const wsClients = new Map();

const wsConnectionCount = new Map();
const MAX_WS_PER_IP = 10;

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress || "unknown";

  const currentCount = wsConnectionCount.get(ip) || 0;
  if (currentCount >= MAX_WS_PER_IP) {
    ws.close(1013, "Too many connections");
    return;
  }
  wsConnectionCount.set(ip, currentCount + 1);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const botId = url.searchParams.get("botId");

  if (botId) {
    if (!wsClients.has(botId)) wsClients.set(botId, new Set());
    wsClients.get(botId).add(ws);
    
    // Send existing logs to new client
    const info = runningBots.get(botId);
    if (info && info.logs.length > 0) {
      for (const entry of info.logs.slice(-50)) {
        ws.send(JSON.stringify(entry));
      }
    }
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("close", () => {
    if (botId) wsClients.get(botId)?.delete(ws);
    const count = wsConnectionCount.get(ip) || 1;
    if (count <= 1) wsConnectionCount.delete(ip);
    else wsConnectionCount.set(ip, count - 1);
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(pingInterval));

function broadcastLog(botId, entry) {
  const clients = wsClients.get(botId);
  if (!clients) return;
  const msg = JSON.stringify(entry);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(msg); }
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "pipe" });
    let output = "";
    proc.stdout.on("data", (d) => (output += d.toString()));
    proc.stderr.on("data", (d) => (output += d.toString()));
    proc.on("close", (code) => { if (code === 0) resolve(output); else reject(new Error(`Falhou (${code}): ${output}`)); });
    proc.on("error", reject);
  });
}

// ─── Memory monitor: kill bots over limit ───
setInterval(() => {
  for (const [botId, info] of runningBots) {
    try {
      const pidStatus = fs.readFileSync(`/proc/${info.process.pid}/status`, "utf-8");
      const vmRss = pidStatus.match(/VmRSS:\s+(\d+)/);
      if (vmRss) {
        const memMb = parseInt(vmRss[1]) / 1024;
        if (memMb > 256) {
          console.log(`⚠️ Bot ${botId} exceeded 256MB (${memMb.toFixed(0)}MB). Killing...`);
          kill(info.process.pid, "SIGKILL");
          runningBots.delete(botId);
          broadcastLog(botId, { timestamp: new Date().toISOString(), level: "error", message: `Bot encerrado: limite de memória (${memMb.toFixed(0)}MB/256MB)` });
        }
      }
    } catch {}
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`🤖 LPZX Hosting Backend rodando na porta ${PORT}`);
  console.log(`📁 Bots: ${BOTS_DIR}`);
  console.log(`🛡️  Rate limits: 100 req/min global, 10/min exec, 5/min deploy`);
  console.log(`🔌 Max ${MAX_WS_PER_IP} WebSocket connections per IP`);
  console.log(`🧠 Memory monitor: auto-kill bots > 256MB`);
  console.log(`📦 Deploy agora injeta env vars e auto-inicia o bot`);
  if (!SUPABASE_JWT_SECRET) {
    console.warn("⚠️  SUPABASE_JWT_SECRET not set! Run: export SUPABASE_JWT_SECRET=your-secret");
  } else {
    console.log("✅ JWT authentication enabled");
  }
});
