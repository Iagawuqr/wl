// bot.js - LPZX Bot v5 - Discord Lua Tools (APENAS APIS)
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Groq = require('groq-sdk');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const bodyParser = require('body-parser');
require('dotenv').config();

const API_URL = process.env.API_URL || 'https://lpz-dumper.onrender.com';
const WSS_URL = process.env.WSS_URL || 'wss://lpz-dumper.onrender.com';
const OWNER_ID = '1372234679276670990';
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_PORT = process.env.API_PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || 'byslamiddandlppppp';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || '668b1b63-3cd9-4d0f-9d9b-cbe6f1b61296';
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT || '58761fe5969fbfe2fb21ea956571a51ecea0ec20c3d55fdd13f504189f73859b';

const CONFIG_DIR = path.join(__dirname, 'user_configs');
const TEMP_DIR = path.join(__dirname, 'temp');
const CACHE_DIR = path.join(__dirname, 'cache');
const STATS_FILE = path.join(__dirname, 'bot_stats.json');
const UPLOADS_FILE = path.join(__dirname, 'user_uploads.json');
const BATCH_QUEUE_FILE = path.join(__dirname, 'batch_queue.json');
const CHANNEL_CONFIG_FILE = path.join(__dirname, 'channel_config.json');

// ================= CHANNEL CONFIG =================
let allowedChannelId = null;
if (fs.existsSync(CHANNEL_CONFIG_FILE)) {
    try {
        const config = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_FILE));
        allowedChannelId = config.channelId;
        console.log(`[CHANNEL] Canal permitido: ${allowedChannelId}`);
    } catch (e) {}
}

function saveChannelConfig(channelId) {
    allowedChannelId = channelId;
    fs.writeFileSync(CHANNEL_CONFIG_FILE, JSON.stringify({ channelId }, null, 2));
}

// ================= PASTE SERVICES =================
const PASTE_SERVICES = [
    {
        name: 'GitHub Gist',
        url: 'https://api.github.com/gists',
        key: GITHUB_TOKEN,
        format: (id, data) => ({
            url: data?.html_url || `https://gist.github.com/${id}`,
            raw: data?.files[Object.keys(data.files)[0]]?.raw_url || `https://gist.githubusercontent.com/${id}/raw`
        })
    }
];

// ================= SHORTEN SERVICES =================
const SHORTEN_SERVICES = [
    {
        name: 'is.gd',
        url: 'https://is.gd/create.php',
        format: (data) => data.shorturl
    },
    {
        name: 'vgd',
        url: 'https://v.gd/create.php',
        format: (data) => data.shorturl
    },
    {
        name: 'tinyurl',
        url: 'https://tinyurl.com/api-create.php',
        format: (data) => data
    }
];

const MAX_UPLOADS_PER_DAY = 5;
const CACHE_TTL = 24 * 60 * 60 * 1000;

const groq = new Groq({ apiKey: GROQ_API_KEY });

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const DUMPER_PATH = path.join(SCRIPTS_DIR, 'dumper.lua');
const DECOMPILER_PATH = path.join(SCRIPTS_DIR, 'decompiler.lua');
const MINIFY_PATH = path.join(SCRIPTS_DIR, 'minify.lua');

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_CONFIG = {
    max_file_size: 20 * 1024 * 1024,
    deobfuscate_enabled: true,
    rename_variables: true,
    dump_timeout: 30,
    auto_upload: true
};

let stats = {
    total_dumps: 0,
    total_gets: 0,
    total_renames: 0,
    total_analysis: 0,
    total_deobfuscates: 0,
    total_pastes: 0,
    total_detects: 0,
    total_compresses: 0,
    total_minifies: 0,
    total_decompiles: 0,
    total_uploads: 0,
    total_batch_jobs: 0,
    users_served: [],
    commands_used: {},
    start_time: Date.now()
};

let cache = new Map();
let userUploads = {};
let batchQueue = [];

function getUserConfig(userId) {
    const configFile = path.join(CONFIG_DIR, `${userId}.json`);
    if (fs.existsSync(configFile)) {
        try {
            return JSON.parse(fs.readFileSync(configFile));
        } catch (e) {}
    }
    return { ...DEFAULT_CONFIG };
}

function saveUserConfig(userId, config) {
    const configFile = path.join(CONFIG_DIR, `${userId}.json`);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

if (fs.existsSync(STATS_FILE)) {
    try {
        const savedStats = JSON.parse(fs.readFileSync(STATS_FILE));
        stats = { ...stats, ...savedStats };
        if (!stats.users_served) stats.users_served = [];
    } catch (e) {}
}

if (fs.existsSync(UPLOADS_FILE)) {
    try {
        userUploads = JSON.parse(fs.readFileSync(UPLOADS_FILE));
        const now = Date.now();
        for (const userId in userUploads) {
            userUploads[userId] = userUploads[userId].filter(u => (now - u.timestamp) < 86400000);
        }
    } catch (e) {}
}

if (fs.existsSync(BATCH_QUEUE_FILE)) {
    try {
        batchQueue = JSON.parse(fs.readFileSync(BATCH_QUEUE_FILE));
    } catch (e) {}
}

if (fs.existsSync(path.join(CACHE_DIR, 'cache.json'))) {
    try {
        const savedCache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'cache.json')));
        cache = new Map(savedCache);
    } catch (e) {}
}

function saveStats() {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function saveUploads() {
    fs.writeFileSync(UPLOADS_FILE, JSON.stringify(userUploads, null, 2));
}

function saveBatchQueue() {
    fs.writeFileSync(BATCH_QUEUE_FILE, JSON.stringify(batchQueue, null, 2));
}

function saveCache() {
    const cacheArray = Array.from(cache.entries());
    fs.writeFileSync(path.join(CACHE_DIR, 'cache.json'), JSON.stringify(cacheArray, null, 2));
}

function checkUploadLimit(userId) {
    if (!userUploads[userId]) userUploads[userId] = [];
    const today = new Date().setHours(0,0,0,0);
    const todayUploads = userUploads[userId].filter(u => u.date === today);
    return todayUploads.length < MAX_UPLOADS_PER_DAY;
}

function addUploadRecord(userId, type, url) {
    if (!userUploads[userId]) userUploads[userId] = [];
    userUploads[userId].push({
        date: new Date().setHours(0,0,0,0),
        timestamp: Date.now(),
        type: type,
        url: url
    });
    saveUploads();
}

function getCacheKey(content, type) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    return `${type}_${hash}`;
}

function getFromCache(key) {
    if (cache.has(key)) {
        const item = cache.get(key);
        if (Date.now() - item.timestamp < CACHE_TTL) {
            return item.data;
        } else {
            cache.delete(key);
        }
    }
    return null;
}

function addToCache(key, data) {
    cache.set(key, {
        timestamp: Date.now(),
        data: data
    });
    saveCache();
}

const ALLOWED_EXTENSIONS = ['.lua', '.txt', '.luac', '.luc', '.bytecode'];

const OBFUSCATOR_SIGNATURES = [
    { 
        name: 'IronBrew', 
        signatures: [
            'IronBrew', 'ironbrew', '-- IronBrew', 'Iron Brew', 'brew', 'IronBrew V2'
        ],
        description: 'IronBrew obfuscator with bytecode and flow control'
    },
    { 
        name: 'Prometheus', 
        signatures: [
            'Prometheus', 'prometheus', '-- Prometheus', 'prom v2', 'prom v3'
        ],
        description: 'Prometheus obfuscator with multiple layers'
    },
    { 
        name: 'WeAreDevs', 
        signatures: [
            'WeAreDevs', 'wearedevs', 'WAD', '-- WeAreDevs', 'exploit'
        ],
        description: 'WeAreDevs community obfuscator'
    },
    { 
        name: 'Moonix', 
        signatures: [
            'Moonix', 'moonix', '-- Moonix', 'MooNix'
        ],
        description: 'Modern Lua obfuscator'
    },
    { 
        name: 'MagicSec', 
        signatures: [
            'MagicSec', 'magicsec', '-- MagicSec', 'Protected by MagicSec',
            'MagicSec V2', 'magicsec.com', 'magicsec.vip', 'MagicSec Obfuscator'
        ],
        description: 'MagicSec obfuscator (magicsec.vip) with string encryption'
    },
    { 
        name: 'MoonVeil', 
        signatures: [
            'MoonVeil', 'moonveil', '-- MoonVeil', 'Protected by MoonVeil',
            'MoonVeil V2', 'moonveil.xyz', 'MoonVeil Obfuscator'
        ],
        description: 'MoonVeil obfuscator with virtual machine protection'
    },
    { 
        name: 'LuaObfuscator', 
        signatures: [
            'LuaObfuscator', 'luaobfuscator.com', '-- LuaObfuscator',
            'Protected by LuaObfuscator', 'LuaObfuscator V2'
        ],
        description: 'LuaObfuscator.com with multiple layers'
    },
    { 
        name: 'Bytecode', 
        signatures: [
            '\x1bLua', 'LuaQ', 'luac', 'bytecode', 'compiled lua'
        ],
        description: 'Compiled Lua bytecode'
    }
];

const SUPPORTED_OBFUSCATORS = [
    { name: 'IronBrew', description: 'IronBrew obfuscator with bytecode and flow control' },
    { name: 'Prometheus', description: 'Prometheus obfuscator with multiple layers' },
    { name: 'WeAreDevs', description: 'WeAreDevs community obfuscator' },
    { name: 'Moonix', description: 'Modern Lua obfuscator' },
    { name: 'MagicSec', description: 'MagicSec obfuscator (magicsec.vip) with string encryption' },
    { name: 'MoonVeil', description: 'MoonVeil obfuscator with virtual machine protection' },
    { name: 'LuaObfuscator', description: 'LuaObfuscator.com with multiple layers' },
    { name: 'Bytecode', description: 'Compiled Lua bytecode' }
];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: '/auth/discord/callback',
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

async function checkGuildMembership(req, res, next) {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { 'Authorization': `Bearer ${req.user.accessToken}` }
        });
        
        const inGuild = response.data.some(guild => guild.id === DISCORD_GUILD_ID);
        if (!inGuild) return res.status(403).json({ error: 'Not in required guild' });
        next();
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify guild membership' });
    }
}

function authenticateAPI(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
    if (!token || token !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (error) {}
    });
    
    ws.on('close', () => wsClients.delete(ws));
});

function broadcastToClients(data) {
    for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    }
}

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/?auth=success');
    }
);

app.get('/auth/discord/verify', ensureAuthenticated, async (req, res) => {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { 'Authorization': `Bearer ${req.user.accessToken}` }
        });
        
        const inGuild = response.data.some(guild => guild.id === DISCORD_GUILD_ID);
        
        res.json({
            authenticated: true,
            inGuild: inGuild,
            user: {
                id: req.user.id,
                username: req.user.username,
                discriminator: req.user.discriminator,
                avatar: req.user.avatar
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify' });
    }
});

app.post('/auth/captcha/verify', async (req, res) => {
    const { token } = req.body;
    
    if (!token) return res.status(400).json({ error: 'No token' });
    
    try {
        const response = await axios.post('https://hcaptcha.com/siteverify', null, {
            params: {
                secret: HCAPTCHA_SECRET,
                response: token
            }
        });
        
        if (response.data.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Invalid captcha' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Captcha verification failed' });
    }
});

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'online', 
        timestamp: Date.now(),
        environment: ENVIRONMENT,
        discord: client.isReady() ? 'connected' : 'disconnected'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        service: 'lpz-dumper-bot',
        timestamp: Date.now(),
        uptime: process.uptime(),
        discord: client.isReady() ? 'connected' : 'disconnected',
        environment: ENVIRONMENT
    });
});

app.get('/api/stats', authenticateAPI, (req, res) => {
    const uptime = Math.floor((Date.now() - stats.start_time) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        uptime: `${hours}h ${minutes}m`,
        total_dumps: stats.total_dumps,
        total_gets: stats.total_gets,
        total_renames: stats.total_renames,
        total_analysis: stats.total_analysis,
        total_detects: stats.total_detects,
        total_decompiles: stats.total_decompiles,
        total_compresses: stats.total_compresses,
        total_minifies: stats.total_minifies,
        total_uploads: stats.total_uploads,
        total_batch_jobs: stats.total_batch_jobs,
        users_served: stats.users_served.length,
        commands_used: stats.commands_used,
        start_time: stats.start_time,
        environment: ENVIRONMENT
    });
});

app.get('/api/users', authenticateAPI, (req, res) => {
    res.json({
        total: stats.users_served.length,
        users: stats.users_served
    });
});

app.get('/api/commands', authenticateAPI, (req, res) => {
    res.json(stats.commands_used);
});

app.get('/api/uploads/:userId', authenticateAPI, (req, res) => {
    const userId = req.params.userId;
    res.json(userUploads[userId] || []);
});

app.get('/api/cache', authenticateAPI, (req, res) => {
    res.json({
        size: cache.size,
        keys: Array.from(cache.keys()),
        ttl: CACHE_TTL / 1000 / 60 / 60 + ' hours'
    });
});

app.post('/api/cache/clear', authenticateAPI, (req, res) => {
    cache.clear();
    saveCache();
    res.json({ success: true });
});

app.get('/api/batch', authenticateAPI, (req, res) => {
    res.json({
        total: batchQueue.length,
        jobs: batchQueue
    });
});

app.post('/api/batch/clear', authenticateAPI, (req, res) => {
    batchQueue = [];
    saveBatchQueue();
    res.json({ success: true });
});

app.post('/api/dump', authenticateAPI, async (req, res) => {
    const { code, key } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const result = await executeDump(code, key);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get', authenticateAPI, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    
    try {
        const result = await fetchWithWget(url);
        res.json({ success: true, data: result.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/minify', authenticateAPI, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const result = await executeMinify(code);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/decompiler', authenticateAPI, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const result = await executeDecompiler(code);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/compress', authenticateAPI, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const result = await executeCompress(code);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/renamer', authenticateAPI, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const result = await executeRenamer(code);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/detect', authenticateAPI, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    const detection = detectObfuscator(code);
    res.json({ success: true, data: detection });
});

app.post('/api/batch/add', authenticateAPI, async (req, res) => {
    const { type, data, userId } = req.body;
    if (!type || !data) return res.status(400).json({ error: 'Missing data' });
    
    const jobId = crypto.randomBytes(16).toString('hex');
    const job = {
        id: jobId,
        type,
        data,
        userId,
        status: 'pending',
        created: Date.now()
    };
    
    batchQueue.push(job);
    saveBatchQueue();
    stats.total_batch_jobs++;
    saveStats();
    
    broadcastToClients({ type: 'batch_added', job });
    res.json({ success: true, jobId });
});

app.post('/api/batch/process/:jobId', authenticateAPI, async (req, res) => {
    const jobId = req.params.jobId;
    const jobIndex = batchQueue.findIndex(j => j.id === jobId);
    if (jobIndex === -1) return res.status(404).json({ error: 'Job not found' });
    
    const job = batchQueue[jobIndex];
    job.status = 'processing';
    
    try {
        let result;
        switch (job.type) {
            case 'dump': result = await executeDump(job.data.code, job.data.key); break;
            case 'minify': result = await executeMinify(job.data.code); break;
            case 'decompiler': result = await executeDecompiler(job.data.code); break;
            case 'compress': result = await executeCompress(job.data.code); break;
            case 'renamer': result = await executeRenamer(job.data.code); break;
            case 'detect': result = detectObfuscator(job.data.code); break;
            default: throw new Error('Unknown job type');
        }
        
        job.status = 'completed';
        job.result = result;
        job.completed = Date.now();
        
        broadcastToClients({ type: 'batch_completed', job });
        
        setTimeout(() => {
            const index = batchQueue.findIndex(j => j.id === jobId);
            if (index !== -1) {
                batchQueue.splice(index, 1);
                saveBatchQueue();
            }
        }, 3600000);
        
        res.json({ success: true, result });
    } catch (error) {
        job.status = 'failed';
        job.error = error.message;
        job.completed = Date.now();
        broadcastToClients({ type: 'batch_failed', job });
        res.status(500).json({ error: error.message });
    }
    
    saveBatchQueue();
});

app.get('/api/batch/:jobId', authenticateAPI, (req, res) => {
    const job = batchQueue.find(j => j.id === req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ================= NOVAS APIS PARA O SITE =================

// Verificar usuário
app.post('/api/bot/check-user', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    try {
        const response = await axios.post(`${API_URL}/api/credits/check`, { userId }, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        });
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Usar crédito
app.post('/api/bot/use-credit', async (req, res) => {
    const { userId, command, username } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    try {
        const response = await axios.post(`${API_URL}/api/credits/use`, 
            { userId, command, username },
            { headers: { 'Authorization': `Bearer ${API_TOKEN}` } }
        );
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Definir créditos
app.post('/api/bot/set-credits', async (req, res) => {
    const { userId, amount, verified } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    try {
        const response = await axios.post(`${API_URL}/api/credits/set`, 
            { userId, amount, verified },
            { headers: { 'Authorization': `Bearer ${API_TOKEN}` } }
        );
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Buscar estatísticas
app.get('/api/bot/stats', async (req, res) => {
    try {
        const response = await axios.get(`${API_URL}/api/stats`, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        });
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================= WEBSOCKET CLIENT =================
let ws;
function connectWSS() {
    ws = new WebSocket(WSS_URL);
    
    ws.on('open', () => {
        console.log('[WSS] Conectado ao servidor');
        
        // Enviar identificação
        ws.send(JSON.stringify({
            type: 'bot_register',
            botId: client.user?.id || 'unknown',
            botName: client.user?.tag || 'LPZ Bot'
        }));
    });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {}
    });
    
    ws.on('error', (err) => console.error('[WSS] Erro:', err.message));
    
    ws.on('close', () => {
        console.log('[WSS] Desconectado, reconectando...');
        setTimeout(connectWSS, 5000);
    });
}

function sendToSite(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
            type: 'bot_update', 
            updateType: type, 
            ...data 
        }));
    }
}

// ================= SISTEMA DE CRÉDITOS VIA API =================

async function checkUserVerified(userId) {
    try {
        const response = await axios.post(`${API_URL}/api/bot/check-user`, 
            { userId },
            { 
                headers: { 'Authorization': `Bearer ${API_TOKEN}` },
                timeout: 5000
            }
        );
        
        return {
            verified: response.data.verified || false,
            amount: response.data.amount || 0,
            lastReset: response.data.lastReset || Date.now()
        };
    } catch (error) {
        console.error(`[API] Erro ao verificar usuário ${userId}:`, error.message);
        return { verified: false, amount: 0, lastReset: Date.now() };
    }
}

async function useUserCredit(userId, command, username) {
    try {
        const response = await axios.post(`${API_URL}/api/bot/use-credit`,
            { userId, command, username },
            { 
                headers: { 'Authorization': `Bearer ${API_TOKEN}` },
                timeout: 5000
            }
        );
        
        return response.data;
    } catch (error) {
        console.error(`[API] Erro ao usar crédito:`, error.message);
        return { 
            success: false, 
            error: error.response?.data?.error || 'API error',
            needsVerification: error.response?.status === 403
        };
    }
}

async function setUserCredits(userId, amount, verified) {
    try {
        const response = await axios.post(`${API_URL}/api/bot/set-credits`,
            { userId, amount, verified },
            { 
                headers: { 'Authorization': `Bearer ${API_TOKEN}` },
                timeout: 5000
            }
        );
        
        return response.data;
    } catch (error) {
        console.error(`[API] Erro ao definir créditos:`, error.message);
        return { success: false };
    }
}

// ================= HELPER FUNCTIONS =================

async function shortenUrl(url) {
    for (const service of SHORTEN_SERVICES) {
        try {
            let response;
            if (service.name === 'is.gd' || service.name === 'vgd') {
                response = await axios.get(service.url, {
                    params: { format: 'json', url },
                    timeout: 5000
                });
                if (response.data?.shorturl) return response.data.shorturl;
            } else if (service.name === 'tinyurl') {
                response = await axios.get(service.url, { params: { url }, timeout: 5000 });
                if (response.data) return response.data;
            }
        } catch (error) {
            continue;
        }
    }
    return url;
}

async function fetchWithWget(url) {
    const outputFile = path.join(TEMP_DIR, `wget_${Date.now()}.lua`);
    
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Krnl/1.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Delta/3.2.1 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Synapse/3.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ];

    for (const ua of userAgents) {
        try {
            console.log(`[WGET] Tentando com User-Agent: ${ua.substring(0, 30)}...`);
            
            const wgetCmd = `wget \
                --user-agent="${ua}" \
                --header="Accept: text/plain,application/x-lua,*/*" \
                --header="Accept-Language: en-US,en;q=0.9" \
                --header="Referer: https://www.google.com/" \
                --timeout=15 \
                --tries=2 \
                --no-check-certificate \
                -O "${outputFile}" \
                "${url}" 2>&1`;
            
            await new Promise((resolve, reject) => {
                exec(wgetCmd, (error, stdout, stderr) => {
                    if (error && !fs.existsSync(outputFile)) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            if (!fs.existsSync(outputFile)) {
                console.log(`[WGET] Arquivo não foi criado`);
                continue;
            }

            let content = fs.readFileSync(outputFile, 'utf8');
            
            const isHTML = content.includes('<!DOCTYPE') || 
                          content.includes('<html') || 
                          content.includes('<head') ||
                          content.includes('<body') ||
                          content.includes('404 Not Found') ||
                          content.includes('403 Forbidden') ||
                          content.includes('Access Denied') ||
                          content.includes('Cloudflare') ||
                          content.length < 100;

            if (isHTML) {
                console.log(`[WGET] Conteúdo HTML detectado (${content.length} bytes), tentando próximo UA...`);
                fs.unlinkSync(outputFile);
                continue;
            }

            fs.unlinkSync(outputFile);
            content = content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
            console.log(`[WGET] Download bem-sucedido! ${content.length} bytes`);
            
            return { 
                content: content, 
                filePath: outputFile,
                success: true 
            };

        } catch (error) {
            console.log(`[WGET] Erro com UA atual: ${error.message.substring(0, 50)}`);
            if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        }
    }
    
    try {
        console.log('[WGET] Todas tentativas falharam, usando axios...');
        
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/plain,application/x-lua,*/*',
                'Referer': 'https://www.google.com/'
            },
            maxRedirects: 5,
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            }
        });
        
        if (response.data && typeof response.data === 'string') {
            const content = response.data;
            
            if (!content.includes('<!DOCTYPE') && !content.includes('<html') && content.length > 100) {
                console.log(`[AXIOS] Download via axios: ${content.length} bytes`);
                return { 
                    content: content, 
                    filePath: null,
                    success: true 
                };
            }
        }
    } catch (error) {
        console.log('[AXIOS] Falhou:', error.message);
    }
    
    throw new Error('Falha ao baixar arquivo após todas as tentativas');
}

async function uploadToPasteService(content, title) {
    if (!GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN não configurado');
    }
    
    try {
        console.log(`[GIST] Enviando para GitHub...`);
        const response = await axios.post('https://api.github.com/gists', {
            description: title || 'LPZX Upload',
            public: true,
            files: {
                [title || 'script.lua']: { content }
            }
        }, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` },
            timeout: 10000
        });
        
        if (response.data?.id) {
            const file = Object.values(response.data.files)[0];
            console.log(`[GIST] Upload concluído: ${response.data.html_url}`);
            return {
                service: 'GitHub Gist',
                id: response.data.id,
                url: response.data.html_url,
                raw: file.raw_url
            };
        }
    } catch (error) {
        console.error(`[GIST] Erro: ${error.message}`);
        throw error;
    }
}

function formatLuaCode(code) {
    if (!code || code.trim() === '') return code;
    
    const watermarks = [
        '-- this file is generated using larry', '-- generated by larry',
        '-- Larry Deobfuscator', '-- LPZX Deobfuscator',
        '-- Refatorado por LPZ IA', '-- This file was generated By LPZ IA'
    ];
    
    let cleaned = code;
    for (const wm of watermarks) {
        cleaned = cleaned.replace(new RegExp(wm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    }
    
    cleaned = cleaned.replace(/\\n/g, '\n');
    let lines = cleaned.split('\n').filter(l => l.trim() !== '');
    
    const formatted = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trimRight();
        formatted.push(line);
        
        if (line.includes(':connect(') || line.includes(':Connect(') ||
            line === 'end' || line === 'end)') {
            formatted.push('');
        }
    }
    
    const finalLines = formatted.filter((l, i) => !(l === '' && (i === 0 || formatted[i-1] === '')));
    
    const watermark = `-- ========================================\n` +
                     `-- Deobfuscated by LPZ Bot Dumper V1\n` +
                     `-- Discord: https://discord.gg/NC8tTeewjp\n` +
                     `-- Environment: ${ENVIRONMENT}\n` +
                     `-- ========================================\n\n`;
    
    return watermark + finalLines.join('\n');
}

function createLoadString(code) {
    const escaped = code
        .replace(/\\/g, '\\\\')
        .replace(/'''/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\[\[/g, '\\[\\[')
        .replace(/\]\]/g, '\\]\\]')
        .replace(/\n/g, '\\n');
    return `loadstring([[${escaped}]])()`;
}

function detectObfuscator(code) {
    for (const obf of OBFUSCATOR_SIGNATURES) {
        for (const sig of obf.signatures) {
            if (code.includes(sig)) {
                return { name: obf.name, signature: sig, description: obf.description, confidence: 'High' };
            }
        }
    }
    return null;
}

async function getCodeFromMessage(message, args) {
    if (message.reference) {
        try {
            const replied = await message.channel.messages.fetch(message.reference.message_id);
            if (replied.attachments?.size > 0) {
                const attachment = replied.attachments.first();
                const ext = path.extname(attachment.name).toLowerCase();
                if (ALLOWED_EXTENSIONS.includes(ext)) {
                    const response = await axios.get(attachment.url, { responseType: 'text' });
                    return response.data;
                }
            }
        } catch {}
    }
    
    if (args.length === 0) return null;
    const input = args.join(' ');
    
    if (input.startsWith('http')) {
        try {
            const result = await fetchWithWget(input);
            return result.content;
        } catch {
            return null;
        }
    }
    return input;
}

async function executeDump(code, key) {
    return new Promise((resolve, reject) => {
        const inputFile = path.join(TEMP_DIR, `dump_${Date.now()}.lua`);
        const outputFile = path.join(TEMP_DIR, `dump_out_${Date.now()}.lua`);
        fs.writeFileSync(inputFile, code);
        
        let cmd = `lua "${DUMPER_PATH}" "${inputFile}" "${outputFile}"`;
        if (key) cmd += ` "${key}"`;
        
        console.log(`[DUMP] Executando: ${cmd}`);
        
        exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
            fs.unlinkSync(inputFile);
            
            if (error) {
                console.log(`[DUMP] Erro: ${error.message}`);
                if (!fs.existsSync(outputFile)) reject(error);
                else {
                    const result = fs.readFileSync(outputFile, 'utf8');
                    fs.unlinkSync(outputFile);
                    resolve(result);
                }
            } else if (fs.existsSync(outputFile)) {
                const result = fs.readFileSync(outputFile, 'utf8');
                fs.unlinkSync(outputFile);
                resolve(result);
            } else reject(new Error('Nenhum arquivo de saída gerado'));
        });
    });
}

async function executeMinify(code) {
    return new Promise((resolve, reject) => {
        const inputFile = path.join(TEMP_DIR, `minify_${Date.now()}.lua`);
        const outputFile = path.join(TEMP_DIR, `minify_out_${Date.now()}.lua`);
        fs.writeFileSync(inputFile, code);
        
        exec(`lua "${MINIFY_PATH}" minify "${inputFile}" > "${outputFile}"`, { timeout: 30000 }, (error) => {
            fs.unlinkSync(inputFile);
            if (error && !fs.existsSync(outputFile)) reject(error);
            else if (fs.existsSync(outputFile)) {
                const result = fs.readFileSync(outputFile, 'utf8');
                fs.unlinkSync(outputFile);
                resolve(result);
            } else reject(new Error('No output'));
        });
    });
}

async function executeDecompiler(code) {
    return new Promise((resolve, reject) => {
        const inputFile = path.join(TEMP_DIR, `decomp_${Date.now()}.luac`);
        const outputFile = path.join(TEMP_DIR, `decomp_out_${Date.now()}.lua`);
        fs.writeFileSync(inputFile, code, 'binary');
        
        exec(`lua "${DECOMPILER_PATH}" "${inputFile}" "${outputFile}"`, { timeout: 30000 }, (error) => {
            fs.unlinkSync(inputFile);
            if (error && !fs.existsSync(outputFile)) reject(error);
            else if (fs.existsSync(outputFile)) {
                const result = fs.readFileSync(outputFile, 'utf8');
                fs.unlinkSync(outputFile);
                resolve(result);
            } else reject(new Error('No output'));
        });
    });
}

async function executeCompress(code) {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
    const response = await groq.chat.completions.create({
        model: 'mixtral-8x7b-32768',
        messages: [
            { role: 'system', content: 'Compress Lua code removing spaces/comments. Return ONLY code.' },
            { role: 'user', content: code }
        ],
        temperature: 0.2, max_tokens: 8000
    });
    return response.choices[0].message.content.replace(/```lua\n?/g, '').replace(/```\n?/g, '').trim();
}

async function executeRenamer(code) {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
    const response = await groq.chat.completions.create({
        model: 'mixtral-8x7b-32768',
        messages: [
            { role: 'system', content: 'Rename obfuscated Lua variables to descriptive names. Return ONLY code.' },
            { role: 'user', content: code }
        ],
        temperature: 0.3, max_tokens: 8000
    });
    return response.choices[0].message.content.replace(/```lua\n?/g, '').replace(/```\n?/g, '').trim();
}

// ================= DISCORD HANDLERS =================

async function handleDetect(message, args, statusMsg) {
    await statusMsg.edit('🔍 Detectando ofuscador...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .detect <code/URL> or reply to a file');
    
    stats.total_detects++;
    const detection = detectObfuscator(code);
    
    const embed = new EmbedBuilder()
        .setColor(detection ? 0x00FF00 : 0xFFA500)
        .setTitle('Detect')
        .setFooter({ text: 'By LPZ Hub Team' });
    
    if (detection) {
        embed.addFields(
            { name: 'Obfuscator', value: detection.name, inline: true },
            { name: 'Confidence', value: detection.confidence, inline: true },
            { name: 'Description', value: detection.description, inline: false }
        );
    } else {
        embed.setDescription('Nenhum ofuscador conhecido detectado');
    }
    
    await statusMsg.edit({ content: '✅ Detection completed!', embeds: [embed] });
}

async function handleGet(message, args, statusMsg) {
    await statusMsg.edit('📥 Baixando conteúdo...');
    
    if (args.length === 0) return statusMsg.edit('Use: .get <URL>');
    const url = args.join(' ');
    if (!url.startsWith('http')) return statusMsg.edit('URL inválida');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    
    try {
        const { content, filePath } = await fetchWithWget(url);
        if (!content?.trim()) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return statusMsg.edit('Erro: Conteúdo baixado vazio');
        }
        
        stats.total_gets++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const formatted = formatLuaCode(content);
        
        const urlPath = new URL(url).pathname;
        const ext = path.extname(urlPath).toLowerCase() || '.lua';
        const fileName = `get_${Date.now()}${ext}`;
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, fileName);
            stats.total_pastes++;
        } catch (e) {
            console.error('[GIST] Upload failed:', e.message);
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Get')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Linhas', value: `${formatted.split('\n').length}`, inline: true },
                { name: 'Tamanho', value: `${(formatted.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'get', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('Get - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const outputFile = path.join(TEMP_DIR, fileName);
        fs.writeFileSync(outputFile, formatted);
        const attach = new AttachmentBuilder(outputFile);
        
        await statusMsg.edit({ content: '✅ Download completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        
    } catch (error) {
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleDump(message, args, statusMsg) {
    await statusMsg.edit('⚡ Executando dump...');
    
    let key = null;
    if (args.length > 0 && args[0].startsWith('key:')) key = args.shift().substring(4);
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .dump <code/URL> or reply to a file');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    const userConfig = getUserConfig(message.author.id);
    const timeout = userConfig.dump_timeout || 30;
    
    const inputFile = path.join(TEMP_DIR, `dump_in_${Date.now()}.lua`);
    const outputFile = path.join(TEMP_DIR, `dump_out_${Date.now()}.lua`);
    
    try {
        fs.writeFileSync(inputFile, code);
        let cmd = `lua "${DUMPER_PATH}" "${inputFile}" "${outputFile}"`;
        if (key) cmd += ` "${key}"`;
        
        await statusMsg.edit(`⏳ Aguardando resposta do dumper (timeout: ${timeout}s)...`);
        
        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: timeout * 1000 }, (error) => {
                if (error && !fs.existsSync(outputFile)) {
                    if (error.killed || error.signal === 'SIGTERM') reject(new Error(`Timeout após ${timeout}s`));
                    else reject(error);
                } else resolve();
            });
        });
        
        let result = '';
        if (fs.existsSync(outputFile)) result = fs.readFileSync(outputFile, 'utf8');
        
        stats.total_dumps++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const formatted = formatLuaCode(result);
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, `dump_${Date.now()}.lua`);
            stats.total_pastes++;
        } catch (e) {
            console.error('[GIST] Upload failed:', e.message);
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x9933FF)
            .setTitle('Dump')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Linhas', value: `${formatted.split('\n').length}`, inline: true },
                { name: 'Tamanho', value: `${(formatted.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'dump', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        if (parseFloat(elapsedTime) > timeout * 0.8) {
            embed.addFields({ name: '⚠️ Aviso', value: `Próximo do limite de timeout (${timeout}s)`, inline: false });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0x9933FF)
                .setTitle('Dump - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const dumpFile = path.join(TEMP_DIR, `dump_${Date.now()}.lua`);
        fs.writeFileSync(dumpFile, formatted);
        const attach = new AttachmentBuilder(dumpFile);
        
        await statusMsg.edit({ content: '✅ Dump completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);
        
    } catch (error) {
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        if (error.message.includes('Timeout')) {
            await statusMsg.edit(`❌ Dump timeout após ${timeout}s. Use .config set dump_timeout 60`);
        } else {
            await statusMsg.edit(`❌ Erro: ${error.message}`);
        }
    }
}

async function handleDecompiler(message, args, statusMsg) {
    await statusMsg.edit('🔧 Executando decompilador...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .decompiler <file/URL> or reply to a .luac file');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    const inputFile = path.join(TEMP_DIR, `decomp_in_${Date.now()}.luac`);
    const outputFile = path.join(TEMP_DIR, `decomp_out_${Date.now()}.lua`);
    
    try {
        fs.writeFileSync(inputFile, typeof code === 'string' && !code.includes('\x1bLua') ? code : code, 'binary');
        await statusMsg.edit('Decompilando bytecode...');
        
        await new Promise((resolve, reject) => {
            exec(`lua "${DECOMPILER_PATH}" "${inputFile}" "${outputFile}"`, { timeout: 30000 }, (error) => {
                if (error && !fs.existsSync(outputFile)) reject(error);
                else resolve();
            });
        });
        
        let result = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
        
        stats.total_decompiles++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const formatted = formatLuaCode(result);
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, `decomp_${Date.now()}.lua`);
            stats.total_pastes++;
        } catch (e) {}
        
        const embed = new EmbedBuilder()
            .setColor(0xFF4500)
            .setTitle('Decompiler')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Linhas', value: `${formatted.split('\n').length}`, inline: true },
                { name: 'Tamanho', value: `${(formatted.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'decompiler', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0xFF4500)
                .setTitle('Decompiler - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const decompFile = path.join(TEMP_DIR, `decompiled_${Date.now()}.lua`);
        fs.writeFileSync(decompFile, formatted);
        const attach = new AttachmentBuilder(decompFile);
        
        await statusMsg.edit({ content: '✅ Decompilation completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        if (fs.existsSync(decompFile)) fs.unlinkSync(decompFile);
        
    } catch (error) {
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleMinify(message, args, statusMsg) {
    await statusMsg.edit('✂️ Minificando código...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .minify <code/URL> or reply to a file');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    const inputFile = path.join(TEMP_DIR, `minify_in_${Date.now()}.lua`);
    const outputFile = path.join(TEMP_DIR, `minify_out_${Date.now()}.lua`);
    
    try {
        fs.writeFileSync(inputFile, code);
        await statusMsg.edit('Executando minify.lua...');
        
        const { stdout, stderr } = await new Promise((resolve, reject) => {
            exec(`lua "${MINIFY_PATH}" minify "${inputFile}" > "${outputFile}"`, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error && !fs.existsSync(outputFile)) reject(error);
                else resolve({ stdout, stderr });
            });
        });
        
        let result = '';
        if (fs.existsSync(outputFile)) result = fs.readFileSync(outputFile, 'utf8');
        else if (stdout) result = stdout;
        else result = stderr;
        
        if (result.includes('<Symbol') || result.includes('at:')) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Minify Error')
                .setDescription('```\n' + result.substring(0, 1000) + '\n```')
                .addFields({ name: 'Error', value: 'Syntax error in code', inline: false })
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
            if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
            return statusMsg.edit({ content: '❌ Minify failed!', embeds: [embed] });
        }
        
        stats.total_minifies++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const reduction = ((1 - result.length / code.length) * 100).toFixed(1);
        
        const formatted = result;
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, `minify_${Date.now()}.lua`);
            stats.total_pastes++;
        } catch (e) {}
        
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Minify')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Original', value: `${code.split('\n').length} linhas`, inline: true },
                { name: 'Minificado', value: `${formatted.split('\n').length} linhas`, inline: true },
                { name: 'Redução', value: `${reduction}%`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'minify', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Minify - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const minifyFile = path.join(TEMP_DIR, `minified_${Date.now()}.lua`);
        fs.writeFileSync(minifyFile, formatted);
        const attach = new AttachmentBuilder(minifyFile);
        
        await statusMsg.edit({ content: '✅ Minification completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        if (fs.existsSync(minifyFile)) fs.unlinkSync(minifyFile);
        
    } catch (error) {
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleCompress(message, args, statusMsg) {
    if (!GROQ_API_KEY) return statusMsg.edit('GROQ_API_KEY não configurado');
    
    await statusMsg.edit('🗜️ Comprimindo código...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .compress <code/URL> or reply to a file');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    
    try {
        await statusMsg.edit('Enviando para IA...');
        
        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { role: 'system', content: 'Compress Lua code removing spaces/comments. Return ONLY compressed code.' },
                { role: 'user', content: code }
            ],
            temperature: 0.2, max_tokens: 8000
        });
        
        let compressed = response.choices[0].message.content
            .replace(/```lua\n?/g, '').replace(/```\n?/g, '').trim();
        
        stats.total_compresses++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const reduction = ((1 - compressed.length / code.length) * 100).toFixed(1);
        
        const formatted = compressed;
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, `compress_${Date.now()}.lua`);
            stats.total_pastes++;
        } catch (e) {}
        
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Compress')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Original', value: `${code.split('\n').length} linhas`, inline: true },
                { name: 'Comprimido', value: `${formatted.split('\n').length} linhas`, inline: true },
                { name: 'Redução', value: `${reduction}%`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'compress', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Compress - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const compressFile = path.join(TEMP_DIR, `compressed_${Date.now()}.lua`);
        fs.writeFileSync(compressFile, formatted);
        const attach = new AttachmentBuilder(compressFile);
        
        await statusMsg.edit({ content: '✅ Compression completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(compressFile)) fs.unlinkSync(compressFile);
        
    } catch (error) {
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleRenamer(message, args, statusMsg) {
    if (!GROQ_API_KEY) return statusMsg.edit('GROQ_API_KEY não configurado');
    
    await statusMsg.edit('🏷️ Renomeando variáveis...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .renamer <code/URL> or reply to a file');
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    const startTime = Date.now();
    
    try {
        await statusMsg.edit('IA renomeando variáveis...');
        
        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { role: 'system', content: 'Rename obfuscated Lua variables to descriptive names. Return ONLY code.' },
                { role: 'user', content: code }
            ],
            temperature: 0.3, max_tokens: 8000
        });
        
        let renamed = response.choices[0].message.content
            .replace(/```lua\n?/g, '').replace(/```\n?/g, '').trim();
        renamed = `-- Refactored by LPZ AI\n\n${renamed}`;
        
        stats.total_renames++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        const formatted = renamed;
        
        let pasteResult = null;
        try {
            await statusMsg.edit('📤 Enviando para GitHub Gist...');
            pasteResult = await uploadToPasteService(formatted, `renamed_${Date.now()}.lua`);
            stats.total_pastes++;
        } catch (e) {}
        
        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('Renamer')
            .addFields(
                { name: 'Tempo', value: `${elapsedTime}s`, inline: true },
                { name: 'Linhas', value: `${formatted.split('\n').length}`, inline: true },
                { name: 'Tamanho', value: `${(formatted.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (pasteResult) {
            addUploadRecord(message.author.id, 'renamer', pasteResult.url);
            const shortUrl = await shortenUrl(pasteResult.url);
            embed.addFields({ 
                name: 'GitHub Gist', 
                value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }
        
        const loadstring_code = createLoadString(formatted);
        
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('Renamer - Loadstring')
                .setDescription('```lua\n' + loadstring_code + '\n```')
                .setFooter({ text: 'By LPZ Hub Team' });
            
            if (loadstring_code.length > 1900) {
                const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
                await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
            } else {
                await dmChannel.send({ embeds: [dmEmbed] });
            }
        } catch (dmError) {}
        
        const previewLines = formatted.split('\n').slice(0, 5).join('\n');
        const totalLines = formatted.split('\n').length;
        embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
        
        const renameFile = path.join(TEMP_DIR, `renamed_${Date.now()}.lua`);
        fs.writeFileSync(renameFile, formatted);
        const attach = new AttachmentBuilder(renameFile);
        
        await statusMsg.edit({ content: '✅ Renaming completed!', embeds: [embed], files: [attach] });
        
        if (fs.existsSync(renameFile)) fs.unlinkSync(renameFile);
        
    } catch (error) {
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleUpload(message, args, statusMsg) {
    await statusMsg.edit('📤 Processando upload...');
    
    if (!checkUploadLimit(message.author.id)) return statusMsg.edit(`Limite de ${MAX_UPLOADS_PER_DAY} uploads/dia atingido!`);
    
    let content = '', fileName = `upload_${Date.now()}.lua`, filePath = null;
    
    if (args.length > 0 && args[0].startsWith('http')) {
        await statusMsg.edit('Baixando da URL...');
        try {
            const result = await fetchWithWget(args[0]);
            content = result.content;
            filePath = result.filePath;
        } catch (error) {
            return statusMsg.edit(`Erro: ${error.message}`);
        }
    } else if (message.attachments.size > 0) {
        await statusMsg.edit('Baixando arquivo...');
        const attachment = message.attachments.first();
        fileName = attachment.name;
        filePath = path.join(TEMP_DIR, `upload_${Date.now()}_${attachment.name}`);
        try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            fs.writeFileSync(filePath, response.data);
            content = response.data.toString('utf8');
        } catch (error) {
            return statusMsg.edit(`Erro: ${error.message}`);
        }
    } else if (args.length > 0) {
        content = args.join(' ');
    } else {
        return statusMsg.edit('Use: .upload <URL/file/code>');
    }
    
    if (!content?.trim()) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return statusMsg.edit('Conteúdo vazio');
    }
    
    const formatted = formatLuaCode(content);
    
    await statusMsg.edit('Enviando para GitHub Gist...');
    const pasteResult = await uploadToPasteService(formatted, fileName);
    
    if (!pasteResult) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return statusMsg.edit('Erro ao enviar para GitHub Gist');
    }
    
    stats.total_uploads++;
    stats.total_pastes++;
    addUploadRecord(message.author.id, 'upload', pasteResult.url);
    
    const shortUrl = await shortenUrl(pasteResult.url);
    const loadstring_code = createLoadString(formatted);
    
    const embed = new EmbedBuilder()
        .setColor(0x4CAF50)
        .setTitle('Upload')
        .addFields(
            { name: 'Arquivo', value: fileName, inline: true },
            { name: 'Linhas', value: `${formatted.split('\n').length}`, inline: true },
            { name: 'Tamanho', value: `${(formatted.length / 1024).toFixed(2)}KB`, inline: true },
            { name: 'GitHub Gist', value: `[Link](${shortUrl}) | [RAW](${pasteResult.raw})`, inline: false }
        )
        .setFooter({ text: `Uploads restantes: ${MAX_UPLOADS_PER_DAY - userUploads[message.author.id].length}` });
    
    try {
        const dmChannel = await message.author.createDM();
        const dmEmbed = new EmbedBuilder()
            .setColor(0x4CAF50)
            .setTitle('Loadstring')
            .setDescription('```lua\n' + loadstring_code + '\n```')
            .setFooter({ text: 'By LPZ Hub Team' });
        
        if (loadstring_code.length > 1900) {
            const attach = new AttachmentBuilder(Buffer.from(loadstring_code), { name: 'loadstring.lua' });
            await dmChannel.send({ embeds: [dmEmbed], files: [attach] });
        } else {
            await dmChannel.send({ embeds: [dmEmbed] });
        }
    } catch (dmError) {}
    
    const previewLines = formatted.split('\n').slice(0, 5).join('\n');
    const totalLines = formatted.split('\n').length;
    embed.setDescription(`\`\`\`lua\n${previewLines}\n... (${totalLines - 5} more lines)\n\`\`\``);
    
    const uploadFile = path.join(TEMP_DIR, `upload_${Date.now()}_final.lua`);
    fs.writeFileSync(uploadFile, formatted);
    const attach = new AttachmentBuilder(uploadFile);
    
    await statusMsg.edit({ content: '✅ Upload completed!', embeds: [embed], files: [attach] });
    
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(uploadFile)) fs.unlinkSync(uploadFile);
}

async function handleBF(message, args, statusMsg) {
    if (!GROQ_API_KEY) return statusMsg.edit('GROQ_API_KEY não configurado');
    
    await statusMsg.edit('🤖 Analisando código...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) return statusMsg.edit('Use: .bf <code/URL> or reply to a file');
    
    try {
        await statusMsg.edit('IA analisando...');
        
        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { role: 'system', content: 'Analyze Lua code: main function, possible malware, improvements.' },
                { role: 'user', content: code }
            ],
            temperature: 0.7, max_tokens: 4000
        });
        
        const analysis = response.choices[0].message.content;
        stats.total_analysis++;
        
        const embed = new EmbedBuilder()
            .setColor(0xFF6B9D)
            .setTitle('BF - Analysis')
            .setDescription(analysis.substring(0, 4000))
            .setFooter({ text: 'By LPZ Hub Team' });
        
        await statusMsg.edit({ content: '✅ Analysis completed!', embeds: [embed] });
        
    } catch (error) {
        await statusMsg.edit(`❌ Erro: ${error.message}`);
    }
}

async function handleConfig(message, args, statusMsg) {
    const userId = message.author.id;
    const config = getUserConfig(userId);
    
    if (args.length === 0) {
        const embed = new EmbedBuilder()
            .setColor(0x9370DB)
            .setTitle('Config')
            .addFields(
                { name: 'max_file_size', value: `${(config.max_file_size / 1024 / 1024).toFixed(0)}MB`, inline: true },
                { name: 'deobfuscate_enabled', value: config.deobfuscate_enabled ? '✅' : '❌', inline: true },
                { name: 'rename_variables', value: config.rename_variables ? '✅' : '❌', inline: true },
                { name: 'dump_timeout', value: `${config.dump_timeout}s`, inline: true },
                { name: 'auto_upload', value: config.auto_upload ? '✅' : '❌', inline: true }
            )
            .setFooter({ text: 'Use .config set <key> <value>' });
        
        await statusMsg.edit({ content: '⚙️ Configuration:', embeds: [embed] });
        return;
    }
    
    if (args[0] === 'set' && args.length >= 3) {
        const key = args[1];
        const value = args.slice(2).join(' ');
        if (!(key in config)) return statusMsg.edit('❌ Chave inválida');
        
        let newValue = value;
        if (value === 'true') newValue = true;
        else if (value === 'false') newValue = false;
        else if (!isNaN(value)) newValue = Number(value);
        else if (key === 'max_file_size' && value.endsWith('MB')) {
            newValue = parseInt(value) * 1024 * 1024;
        }
        
        config[key] = newValue;
        saveUserConfig(userId, config);
        await statusMsg.edit(`✅ Atualizado: ${key} = ${key === 'max_file_size' ? (newValue/1024/1024).toFixed(0) + 'MB' : newValue}`);
        return;
    }
    
    if (args[0] === 'reset') {
        saveUserConfig(userId, DEFAULT_CONFIG);
        await statusMsg.edit('✅ Configuração resetada');
        return;
    }
    
    await statusMsg.edit('Use: .config, .config set <key> <value>, or .config reset');
}

async function handleStats(message, args, statusMsg) {
    const uptime = Math.floor((Date.now() - stats.start_time) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const today = new Date().setHours(0,0,0,0);
    const todayUploads = Object.values(userUploads).flat().filter(u => u.date === today).length;
    
    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('📊 Estatísticas')
        .addFields(
            { name: 'Uptime', value: `${hours}h ${minutes}m`, inline: true },
            { name: 'Usuários', value: `${stats.users_served.length}`, inline: true },
            { name: 'Dumps', value: `${stats.total_dumps}`, inline: true },
            { name: 'Gets', value: `${stats.total_gets}`, inline: true },
            { name: 'Renames', value: `${stats.total_renames}`, inline: true },
            { name: 'Análises', value: `${stats.total_analysis}`, inline: true },
            { name: 'Detect', value: `${stats.total_detects || 0}`, inline: true },
            { name: 'Decompiles', value: `${stats.total_decompiles || 0}`, inline: true },
            { name: 'Compress', value: `${stats.total_compresses || 0}`, inline: true },
            { name: 'Minify', value: `${stats.total_minifies || 0}`, inline: true },
            { name: 'Uploads', value: `${stats.total_uploads || 0} (${todayUploads}/dia)`, inline: true },
            { name: 'Pastes', value: `${stats.total_pastes}`, inline: true },
            { name: 'Batch Jobs', value: `${stats.total_batch_jobs || 0}`, inline: true },
            { name: 'Cache', value: `${cache.size} itens`, inline: true },
            { name: 'Ambiente', value: ENVIRONMENT, inline: true }
        )
        .setFooter({ text: 'By LPZ Hub Team' });
    
    await statusMsg.edit({ content: '✅ Estatísticas:', embeds: [embed] });
}

async function handleSupported(message, args, statusMsg) {
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Ofuscadores Suportados')
        .setDescription('Lista de ofuscadores que podem ser detectados:');
    
    for (const obf of SUPPORTED_OBFUSCATORS) {
        embed.addFields({ name: obf.name, value: obf.description, inline: false });
    }
    
    await statusMsg.edit({ content: '✅ Ofuscadores suportados:', embeds: [embed] });
}

async function handleSetChannel(message, args, statusMsg) {
    if (message.author.id !== OWNER_ID) {
        return statusMsg.edit('❌ Apenas o dono pode usar este comando');
    }
    
    if (args.length === 0) {
        if (allowedChannelId) {
            const channel = await client.channels.fetch(allowedChannelId).catch(() => null);
            return statusMsg.edit(`📌 Canal atual: ${channel ? channel.name : 'Desconhecido'} (${allowedChannelId})`);
        } else {
            return statusMsg.edit('📌 Nenhum canal configurado. Use .setchannel #canal');
        }
    }
    
    const channel = message.mentions.channels.first();
    if (!channel) return statusMsg.edit('❌ Mencione um canal válido');
    
    saveChannelConfig(channel.id);
    await statusMsg.edit(`✅ Canal configurado: ${channel.name} (${channel.id})`);
}

async function handleHelp(message, args, statusMsg) {
    const isOwner = message.author.id === OWNER_ID;
    
    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('LPZX - Comandos')
        .setDescription('**Comandos disponíveis:**')
        .addFields(
            { name: '.detect <código>', value: 'Detectar ofuscador', inline: false },
            { name: '.dump <código>', value: 'Desofuscar script', inline: false },
            { name: '.decompiler <arquivo>', value: 'Decompilar bytecode', inline: false },
            { name: '.get <URL>', value: 'Baixar conteúdo de URL', inline: false },
            { name: '.upload <URL/arquivo>', value: 'Upload para GitHub Gist', inline: false },
            { name: '.renamer <código>', value: 'Renomear variáveis', inline: false },
            { name: '.bf <código>', value: 'Analisar código com IA', inline: false },
            { name: '.compress <código>', value: 'Comprimir código', inline: false },
            { name: '.minify <código>', value: 'Minificar código', inline: false },
            { name: '.suported', value: 'Listar ofuscadores suportados', inline: false },
            { name: '.stats', value: 'Estatísticas do bot', inline: false },
            { name: '.config', value: 'Configurações do usuário', inline: false },
            { name: '.help', value: 'Esta mensagem', inline: false }
        );
    
    if (isOwner) {
        embed.addFields(
            { name: '👑 **COMANDOS ADMIN**', value: '─────────────', inline: false },
            { name: '.setchannel #canal', value: 'Definir canal permitido', inline: false },
            { name: '.verify @usuário', value: 'Verificar usuário (999 créditos)', inline: false },
            { name: '.setcredits @usuário <quantia>', value: 'Definir créditos manualmente', inline: false },
            { name: '.remove @usuário', value: 'Remover permissões do usuário', inline: false }
        );
    }
    
    embed.addFields(
        { name: '📋 Formatos', value: '.lua .txt .luac .luc .bytecode', inline: false },
        { name: '⚠️ Limites', value: `• Tamanho máximo: 20MB\n• Uploads por dia: ${MAX_UPLOADS_PER_DAY}\n• Timeout: 30s`, inline: false },
        { name: '🌐 Ambiente', value: ENVIRONMENT, inline: false }
    )
    .setFooter({ text: 'By LPZ Hub Team' });
    
    await statusMsg.edit({ content: '✅ Ajuda:', embeds: [embed] });
}

// ================= DISCORD CLIENT =================
client.on('ready', () => {
    console.log(`[BOT] Conectado como ${client.user.tag}`);
    console.log(`[BOT] Scripts: dumper=${fs.existsSync(DUMPER_PATH)}, decompiler=${fs.existsSync(DECOMPILER_PATH)}, minify=${fs.existsSync(MINIFY_PATH)}`);
    console.log(`[BOT] Ambiente: ${ENVIRONMENT}`);
    console.log(`[BOT] ID do Dono: ${OWNER_ID}`);
    
    if (allowedChannelId) {
        console.log(`[BOT] Canal permitido: ${allowedChannelId}`);
    } else {
        console.log(`[BOT] Nenhum canal configurado. Use .setchannel #canal`);
    }
    
    client.user.setActivity('.help | LPZX v5', { type: 'WATCHING' });
    
    // Conectar WebSocket após bot estar pronto
    connectWSS();
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('.') || message.author.bot) return;
    
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const userId = message.author.id;
    
    // Verificar canal permitido (exceto para admin e dono)
    if (allowedChannelId && message.channel.id !== allowedChannelId && userId !== OWNER_ID) {
        const channel = await client.channels.fetch(allowedChannelId).catch(() => null);
        if (channel) {
            return message.reply(`⚠️ Comandos só podem ser usados no canal ${channel.name}`);
        }
        return;
    }
    
    // Admin Commands (só executam se for OWNER)
    if (userId === OWNER_ID) {
        if (command === 'setchannel') {
            const statusMsg = await message.reply('Processando...');
            await handleSetChannel(message, args, statusMsg);
            return;
        }
        
        if (command === 'verify') {
            const target = message.mentions.users.first();
            if (target) { 
                const result = await setUserCredits(target.id, 999, true);
                if (result.success) {
                    sendToSite('user_verified', { 
                        userId: target.id, 
                        username: target.username,
                        by: message.author.username 
                    });
                    return message.reply(`✅ ${target.username} verificado! (999 créditos)`); 
                }
            }
            return;
        }
        
        if (command === 'setcredits') {
            const target = message.mentions.users.first();
            const amount = parseInt(args[1]);
            if (target && !isNaN(amount)) { 
                const result = await setUserCredits(target.id, amount);
                if (result.success) {
                    sendToSite('credits_updated', { 
                        userId: target.id, 
                        username: target.username,
                        amount: amount 
                    });
                    return message.reply(`✅ Definido ${amount} créditos para ${target.username}`); 
                }
            }
            return;
        }
        
        if (command === 'remove') {
            const target = message.mentions.users.first();
            if (target) { 
                const result = await setUserCredits(target.id, 0, false);
                if (result.success) {
                    sendToSite('user_removed', { 
                        userId: target.id, 
                        username: target.username 
                    });
                    return message.reply(`❌ Permissões removidas para ${target.username}`); 
                }
            }
            return;
        }
    }

    // Verificação de Créditos via API para comandos principais
    const mainCommands = ['dump', 'bf', 'get', 'renamer', 'decompiler', 'compress', 'minify'];
    
    if (mainCommands.includes(command)) {
        // Verificar se usuário está verificado via API
        const userStatus = await checkUserVerified(userId);
        
        if (!userStatus.verified) {
            return message.reply(`⚠️ Você precisa se verificar no site primeiro!\n🔗 ${API_URL}`);
        }
        
        if (userStatus.amount <= 0) {
            const timeLeft = Math.ceil((userStatus.lastReset + 86400000 - Date.now()) / 3600000);
            return message.reply(`❌ Seus créditos acabaram! Aguarde ${timeLeft}h para o reset diário.`);
        }
        
        // Usar crédito via API
        const result = await useUserCredit(userId, command, message.author.username);
        
        if (!result.success) {
            if (result.needsVerification) {
                return message.reply(`⚠️ Você precisa se verificar no site!\n🔗 ${API_URL}`);
            }
            return message.reply('❌ Erro ao processar créditos.');
        }
        
        // Enviar para o site via WebSocket
        sendToSite('command_used', { 
            userId, 
            username: message.author.username, 
            command, 
            remaining: result.remaining 
        });
    }

    // Registrar usuário nas estatísticas
    if (!stats.users_served.includes(message.author.id)) {
        stats.users_served.push(message.author.id);
    }
    stats.commands_used[command] = (stats.commands_used[command] || 0) + 1;
    
    const statusMsg = await message.reply('Processando...');
    
    try {
        const handlers = {
            'dump': handleDump, 
            'get': handleGet, 
            'renamer': handleRenamer,
            'config': handleConfig, 
            'bf': handleBF, 
            'stats': handleStats,
            'suported': handleSupported, 
            'detect': handleDetect,
            'decompiler': handleDecompiler, 
            'compress': handleCompress,
            'minify': handleMinify, 
            'upload': handleUpload, 
            'help': handleHelp
        };
        
        if (handlers[command]) {
            await handlers[command](message, args, statusMsg);
            await statusMsg.edit('✅ Comando concluído!').catch(() => {});
        } else {
            await statusMsg.edit('❌ Comando desconhecido. Use .help').catch(() => {});
        }
        
        saveStats();
    } catch (error) {
        console.error(error);
        await statusMsg.edit(`❌ Erro: ${error.message}`).catch(() => {});
    }
});

// Iniciar servidor Express
server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[API] Servidor rodando na porta ${API_PORT}`);
    console.log(`[API] Token: ${API_TOKEN}`);
    console.log(`[API] Ambiente: ${ENVIRONMENT}`);
});

// Login do Discord
if (!TOKEN) {
    console.error('[ERROR] Token do Discord não configurado!');
    process.exit(1);
}

client.login(TOKEN).catch(error => {
    console.error('[ERROR] Erro de conexão:', error.message);
    process.exit(1);
});

console.log('[BOT] LPZX v5 iniciado!');
console.log(`[BOT] Diretório: ${__dirname}`);
console.log(`[BOT] Limite de upload: ${MAX_UPLOADS_PER_DAY}/dia`);
console.log(`[BOT] Ambiente: ${ENVIRONMENT}`);
console.log('[BOT] Arquivos temporários: Auto-delete ativado');