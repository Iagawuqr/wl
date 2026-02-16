// bot.js - LPZX Bot v4 - Discord Lua Tools
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Groq = require('groq-sdk');
require('dotenv').config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CONFIG_DIR = path.join(__dirname, 'user_configs');
const TEMP_DIR = path.join(__dirname, 'temp');
const STATS_FILE = path.join(__dirname, 'bot_stats.json');
const UPLOADS_FILE = path.join(__dirname, 'user_uploads.json');

// Pastefy Configuration
const PASTEFY_API_KEY = "yH1tObeNUqxJsKddVrhQLrkJ4Zqj0AYWqd8hu44U9Cu6jSYFOnzbXe9Apzoi";
const PASTEFY_API_URL = "https://pastefy.app/api/v2/paste";

// Upload limit per user per day
const MAX_UPLOADS_PER_DAY = 5;

// Initialize GROQ
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Script paths
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const DUMPER_PATH = path.join(SCRIPTS_DIR, 'dumper.lua');
const DECOMPILER_PATH = path.join(SCRIPTS_DIR, 'decompiler.lua');
const MINIFY_PATH = path.join(SCRIPTS_DIR, 'minify.lua');

// Create folders if they don't exist
if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Check if scripts exist
if (!fs.existsSync(DUMPER_PATH)) console.warn('[WARN] dumper.lua not found at:', DUMPER_PATH);
if (!fs.existsSync(DECOMPILER_PATH)) console.warn('[WARN] decompiler.lua not found at:', DECOMPILER_PATH);
if (!fs.existsSync(MINIFY_PATH)) console.warn('[WARN] minify.lua not found at:', MINIFY_PATH);

// Default configuration
const DEFAULT_CONFIG = {
    max_file_size: 20 * 1024 * 1024,
    deobfuscate_enabled: true,
    rename_variables: true,
    dump_timeout: 30,
    auto_upload: true
};

// Bot statistics
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
    users_served: [],
    commands_used: {},
    start_time: Date.now()
};

// User upload control
let userUploads = {};

// Load statistics
if (fs.existsSync(STATS_FILE)) {
    try {
        const savedStats = JSON.parse(fs.readFileSync(STATS_FILE));
        stats = { ...stats, ...savedStats };
        if (!stats.users_served) stats.users_served = [];
    } catch (e) {}
}

// Load uploads
if (fs.existsSync(UPLOADS_FILE)) {
    try {
        userUploads = JSON.parse(fs.readFileSync(UPLOADS_FILE));
        // Clean old uploads (>24h)
        const now = Date.now();
        for (const userId in userUploads) {
            userUploads[userId] = userUploads[userId].filter(u => (now - u.timestamp) < 86400000);
        }
    } catch (e) {}
}

function saveStats() {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function saveUploads() {
    fs.writeFileSync(UPLOADS_FILE, JSON.stringify(userUploads, null, 2));
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

const ALLOWED_EXTENSIONS = ['.lua', '.txt', '.luac', '.luc', '.bytecode'];

// Obfuscator detection
const OBFUSCATOR_SIGNATURES = [
    { 
        name: 'MoonSec V3', 
        signatures: [
            'MoonSec', 'moonsec.com', 'federal9999', 'This file was protected with MoonSec',
            'MoonSec V3', '-- MoonSec', 'protected by MoonSec'
        ],
        description: 'MoonSec V3 obfuscator with anti-tamper protection'
    },
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
        name: 'Luarmor', 
        signatures: [
            'luarmor', 'Luarmor', 'api.luarmor.net', 'loadstring', 'luarmor.net', 'Luarmor Lua Obfuscator'
        ],
        description: 'Luarmor protection system (BLOCKED)'
    },
    { 
        name: 'Bytecode', 
        signatures: [
            '\x1bLua', 'LuaQ', 'luac', 'bytecode', 'compiled lua'
        ],
        description: 'Compiled Lua bytecode'
    }
];

// List of supported obfuscators
const SUPPORTED_OBFUSCATORS = OBFUSCATOR_SIGNATURES.map(o => ({
    name: o.name,
    description: o.description
}));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

client.on('ready', () => {
    console.log(`[BOT] Connected as ${client.user.tag}`);
    console.log(`[BOT] Scripts: dumper=${fs.existsSync(DUMPER_PATH)}, decompiler=${fs.existsSync(DECOMPILER_PATH)}, minify=${fs.existsSync(MINIFY_PATH)}`);
    client.user.setActivity('.help | LPZX v4', { type: 'WATCHING' });
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('.') || message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Update stats
    if (!stats.users_served.includes(message.author.id)) {
        stats.users_served.push(message.author.id);
    }
    stats.commands_used[command] = (stats.commands_used[command] || 0) + 1;

    // Send processing status
    const statusMsg = await message.reply('Processing...');

    try {
        const handlers = {
            'dump': () => handleDump(message, args, statusMsg),
            'get': () => handleGet(message, args, statusMsg),
            'renamer': () => handleRenamer(message, args, statusMsg),
            'config': () => handleConfig(message, args, statusMsg),
            'bf': () => handleBF(message, args, statusMsg),
            'stats': () => handleStats(message, args, statusMsg),
            'suported': () => handleSupported(message, args, statusMsg),
            'detect': () => handleDetect(message, args, statusMsg),
            'decompiler': () => handleDecompiler(message, args, statusMsg),
            'compress': () => handleCompress(message, args, statusMsg),
            'minify': () => handleMinify(message, args, statusMsg),
            'upload': () => handleUpload(message, args, statusMsg),
            'help': () => handleHelp(message, args, statusMsg)
        };

        if (handlers[command]) {
            await handlers[command]();
            await statusMsg.edit('Completed!').catch(() => {});
        } else {
            await statusMsg.edit('Unknown command. Use .help').catch(() => {});
        }
        
        saveStats();
    } catch (error) {
        console.error(error);
        await statusMsg.edit(`Error: ${error.message}`).catch(() => {});
    }
});

function getUserConfig(userId) {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    try {
        return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : DEFAULT_CONFIG;
    } catch {
        return DEFAULT_CONFIG;
    }
}

function saveUserConfig(userId, config) {
    fs.writeFileSync(path.join(CONFIG_DIR, `${userId}.json`), JSON.stringify(config, null, 2));
}

// FUNÇÃO WGET CORRIGIDA
async function fetchWithWget(url) {
    const outputFile = path.join(TEMP_DIR, `wget_${Date.now()}.lua`);
    
    // Lista de User-Agents para tentar em ordem
    const userAgents = [
        // Roblox
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Roblox/WinInet',
        'Roblox/WinInet Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Roblox',
        
        // Exploits
        'Krnl/1.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Delta/3.2.1 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Synapse/3.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        
        // Browsers
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'
    ];

    let lastError = null;
    
    for (const ua of userAgents) {
        try {
            console.log(`[WGET] Trying UA: ${ua.substring(0, 50)}...`);
            
            const wgetCmd = `wget ` +
                `--user-agent="${ua}" ` +
                `--header="Accept: */*" ` +
                `--header="Accept-Language: en-US,en;q=0.9" ` +
                `--timeout=15 ` +
                `--tries=2 ` +
                `-O "${outputFile}" ` +
                `"${url}" 2>&1`;

            await new Promise((resolve, reject) => {
                exec(wgetCmd, (error) => {
                    if (error && !fs.existsSync(outputFile)) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            if (!fs.existsSync(outputFile)) continue;

            const content = fs.readFileSync(outputFile, 'utf8');
            
            // Verificar se é HTML de erro
            if (content.includes('<!DOCTYPE') || 
                content.includes('<html') || 
                content.includes('Access Denied') || 
                content.includes('403 Forbidden')) {
                
                fs.unlinkSync(outputFile);
                continue;
            }

            fs.unlinkSync(outputFile);
            return content;

        } catch (error) {
            lastError = error;
            if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        }
    }
    
    throw new Error('Failed to download with all User-Agents');
}

// FUNÇÃO PASTEFY CORRIGIDA
async function uploadToPastefy(content, title) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.post(PASTEFY_API_URL, {
                content: content,
                title: title || 'LPZX Upload',
                syntax: 'lua',
                visibility: 'PUBLIC'
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${PASTEFY_API_KEY}`
                },
                timeout: 15000
            });
            
            if (response.data && response.data.id) {
                stats.total_pastes++;
                return {
                    id: response.data.id,
                    url: `https://pastefy.app/${response.data.id}`,
                    raw: `https://pastefy.app/${response.data.id}/raw`
                };
            }
        } catch (error) {
            if (attempt === 3) return null;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

function detectObfuscator(code) {
    for (const obf of OBFUSCATOR_SIGNATURES) {
        for (const sig of obf.signatures) {
            if (code.includes(sig)) {
                return { 
                    name: obf.name, 
                    signature: sig,
                    description: obf.description,
                    confidence: 'High'
                };
            }
        }
    }
    
    // Generic detection
    if (code.includes('local _0x') || code.match(/local [a-z]\s*=\s*function/g) || 
        code.match(/\=\s*\(\s*function\(/g) || code.includes('loadstring')) {
        return { 
            name: 'Probably obfuscated', 
            signature: 'generic patterns',
            description: 'Code contains common obfuscation patterns',
            confidence: 'Medium'
        };
    }
    
    return null;
}

function isLuarmor(code) {
    const luarmorSignatures = [
        'luarmor', 'Luarmor', 'api.luarmor.net', 'Luarmor Lua Obfuscator',
        'Protected with Luarmor', 'luarmor.net'
    ];
    
    for (const sig of luarmorSignatures) {
        if (code.includes(sig)) return true;
    }
    return false;
}

function isObfuscated(code) {
    return detectObfuscator(code) !== null;
}

function createLoadString(code) {
    const escaped = code.replace(/[[\]()]/g, '\\$&');
    return `loadstring([[\n${escaped}\n]])()`;
}

async function getCodeFromMessage(message, args) {
    // Check if replying to a message with attachment
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

    // Check arguments
    if (args.length === 0) return null;
    
    const input = args.join(' ');
    
    // If it's a URL
    if (input.startsWith('http')) {
        try {
            return await fetchWithWget(input);
        } catch (error) {
            console.error('[FETCH] Error:', error.message);
            return null;
        }
    }
    
    // If it's direct code
    return input;
}

// HANDLE DETECT
async function handleDetect(message, args, statusMsg) {
    await statusMsg.edit('Detecting obfuscator...');
    
    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .detect <code/URL> or reply to a .lua .txt .luac file');
    }

    stats.total_detects++;

    const detection = detectObfuscator(code);
    
    const embed = new EmbedBuilder()
        .setColor(detection ? '#00FF00' : '#FFA500')
        .setTitle('Detect')
        .setFooter({ text: 'By LPZ Hub Team' });

    if (detection) {
        embed.addFields(
            { name: 'Obfuscator', value: detection.name, inline: true },
            { name: 'Confidence', value: detection.confidence, inline: true },
            { name: 'Description', value: detection.description, inline: false }
        );
        
        if (detection.name === 'Luarmor') {
            embed.addFields({ name: '⚠️ BLOCKED', value: 'Luarmor is not supported', inline: false });
        }
    } else {
        embed.setDescription('No known obfuscator detected');
    }

    await statusMsg.edit({ content: 'Detection completed!', embeds: [embed] });
}

// HANDLE GET
async function handleGet(message, args, statusMsg) {
    await statusMsg.edit('Downloading content with wget...');

    if (args.length === 0) {
        return statusMsg.edit('Use: .get <URL>');
    }

    const url = args.join(' ');
    if (!url.startsWith('http')) {
        return statusMsg.edit('Invalid URL');
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    const startTime = Date.now();

    try {
        await statusMsg.edit('Running wget...');
        
        const content = await fetchWithWget(url);
        
        if (!content || content.trim().length === 0) {
            return statusMsg.edit('Error: Downloaded content is empty');
        }

        stats.total_gets++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        const pasteResult = await uploadToPastefy(content, `get_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'get', pasteResult.url);

        const loadstring_code = createLoadString(content);

        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('Get')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Lines', value: `${content.split('\n').length}`, inline: true },
                { name: 'Size', value: `${(content.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ 
                name: 'Pastefy', 
                value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, 
                inline: false 
            });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#0099FF')
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

        // ALWAYS send file
        const fileName = `get_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(content), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${content.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Download completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE DUMP
async function handleDump(message, args, statusMsg) {
    await statusMsg.edit('Executing dump...');
    
    let key = null;
    if (args.length > 0 && args[0].startsWith('key:')) {
        key = args.shift().substring(4);
    }

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .dump <code/URL> or reply to a .lua .txt .luac file');
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    // BLOCK LUARMOR
    if (isLuarmor(code)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Error')
            .setDescription('Luarmor is BLOCKED and not supported by the dumper')
            .addFields({ name: 'Reason', value: 'Luarmor protection detected', inline: false })
            .setFooter({ text: 'By LPZ Hub Team' });
        return statusMsg.edit({ content: 'Blocked!', embeds: [embed] });
    }

    const startTime = Date.now();

    try {
        const inputFile = path.join(TEMP_DIR, `dump_in_${Date.now()}.lua`);
        const outputFile = path.join(TEMP_DIR, `dump_out_${Date.now()}.lua`);
        
        fs.writeFileSync(inputFile, code);

        let cmd = `lua "${DUMPER_PATH}" "${inputFile}" "${outputFile}"`;
        if (key) cmd += ` "${key}"`;

        await statusMsg.edit('Waiting for dumper response...');

        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 30000 }, (error) => {
                if (error && !fs.existsSync(outputFile)) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        fs.unlinkSync(inputFile);

        let result = '';
        if (fs.existsSync(outputFile)) {
            result = fs.readFileSync(outputFile, 'utf8');
            fs.unlinkSync(outputFile);
        }

        stats.total_dumps++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        const pasteResult = await uploadToPastefy(result, `dump_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'dump', pasteResult.url);

        const loadstring_code = createLoadString(result);

        const embed = new EmbedBuilder()
            .setColor('#9933FF')
            .setTitle('Dump')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Lines', value: `${result.split('\n').length}`, inline: true },
                { name: 'Size', value: `${(result.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#9933FF')
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

        // ALWAYS send file
        const fileName = `dump_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(result), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${result.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Dump completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE DECOMPILER
async function handleDecompiler(message, args, statusMsg) {
    await statusMsg.edit('Executing decompiler...');

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .decompiler <file/URL> or reply to a .luac file');
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    const startTime = Date.now();

    try {
        const inputFile = path.join(TEMP_DIR, `decomp_in_${Date.now()}.luac`);
        const outputFile = path.join(TEMP_DIR, `decomp_out_${Date.now()}.lua`);
        
        if (typeof code === 'string' && !code.includes('\x1bLua')) {
            fs.writeFileSync(inputFile, code, 'binary');
        } else {
            fs.writeFileSync(inputFile, code);
        }

        await statusMsg.edit('Decompiling bytecode...');

        await new Promise((resolve, reject) => {
            exec(`lua "${DECOMPILER_PATH}" "${inputFile}" "${outputFile}"`, { timeout: 30000 }, (error) => {
                if (error && !fs.existsSync(outputFile)) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        fs.unlinkSync(inputFile);

        let result = '';
        if (fs.existsSync(outputFile)) {
            result = fs.readFileSync(outputFile, 'utf8');
            fs.unlinkSync(outputFile);
        }

        stats.total_decompiles++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        const pasteResult = await uploadToPastefy(result, `decomp_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'decompiler', pasteResult.url);

        const loadstring_code = createLoadString(result);

        const embed = new EmbedBuilder()
            .setColor('#FF4500')
            .setTitle('Decompiler')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Lines', value: `${result.split('\n').length}`, inline: true },
                { name: 'Size', value: `${(result.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#FF4500')
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

        // ALWAYS send file
        const fileName = `decompiled_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(result), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${result.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Decompilation completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE MINIFY - CORRIGIDO
async function handleMinify(message, args, statusMsg) {
    await statusMsg.edit('Minifying code...');

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .minify <code/URL> or reply to a .lua .txt file');
    }

    // BLOCK LUARMOR
    if (isLuarmor(code)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Error')
            .setDescription('Luarmor is BLOCKED and cannot be minified')
            .addFields({ name: 'Reason', value: 'Luarmor protection detected', inline: false })
            .setFooter({ text: 'By LPZ Hub Team' });
        return statusMsg.edit({ content: 'Blocked!', embeds: [embed] });
    }

    // Check if obfuscated (but not Luarmor)
    if (isObfuscated(code)) {
        return statusMsg.edit('Obfuscated code detected! Use .dump or .renamer first.');
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    const startTime = Date.now();

    try {
        const inputFile = path.join(TEMP_DIR, `minify_in_${Date.now()}.lua`);
        const outputFile = path.join(TEMP_DIR, `minify_out_${Date.now()}.lua`);
        
        fs.writeFileSync(inputFile, code);

        await statusMsg.edit('Running minify.lua...');

        await new Promise((resolve, reject) => {
            exec(`lua "${MINIFY_PATH}" minify "${inputFile}" > "${outputFile}"`, { timeout: 30000 }, (error) => {
                if (error && !fs.existsSync(outputFile)) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        fs.unlinkSync(inputFile);

        let result = '';
        if (fs.existsSync(outputFile)) {
            result = fs.readFileSync(outputFile, 'utf8');
            fs.unlinkSync(outputFile);
        }

        stats.total_minifies++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const reduction = ((1 - result.length / code.length) * 100).toFixed(1);

        const pasteResult = await uploadToPastefy(result, `minify_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'minify', pasteResult.url);

        const loadstring_code = createLoadString(result);

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Minify')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Original', value: `${code.split('\n').length} lines`, inline: true },
                { name: 'Minified', value: `${result.split('\n').length} lines`, inline: true },
                { name: 'Reduction', value: `${reduction}%`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#00FF00')
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

        // ALWAYS send file
        const fileName = `minified_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(result), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${result.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Minification completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE COMPRESS - CORRIGIDO
async function handleCompress(message, args, statusMsg) {
    if (!GROQ_API_KEY) {
        return statusMsg.edit('GROQ_API_KEY not configured');
    }

    await statusMsg.edit('Compressing code...');

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .compress <code/URL> or reply to a .lua .txt file');
    }

    // BLOCK LUARMOR
    if (isLuarmor(code)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Error')
            .setDescription('Luarmor is BLOCKED and cannot be compressed')
            .addFields({ name: 'Reason', value: 'Luarmor protection detected', inline: false })
            .setFooter({ text: 'By LPZ Hub Team' });
        return statusMsg.edit({ content: 'Blocked!', embeds: [embed] });
    }

    // Check if obfuscated (but not Luarmor)
    if (isObfuscated(code)) {
        return statusMsg.edit('Obfuscated code detected! Use .dump or .renamer first.');
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    const startTime = Date.now();

    try {
        await statusMsg.edit('Sending to AI...');

        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { 
                    role: 'system', 
                    content: 'Compress Lua code by removing unnecessary spaces, comments, and blank lines. Keep functionality identical. Return ONLY the compressed code, no explanations.' 
                },
                { role: 'user', content: code }
            ],
            temperature: 0.2,
            max_tokens: 8000
        });

        let compressed = response.choices[0].message.content
            .replace(/```lua\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        stats.total_compresses++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const reduction = ((1 - compressed.length / code.length) * 100).toFixed(1);

        const pasteResult = await uploadToPastefy(compressed, `compress_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'compress', pasteResult.url);

        const loadstring_code = createLoadString(compressed);

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Compress')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Original', value: `${code.split('\n').length} lines`, inline: true },
                { name: 'Compressed', value: `${compressed.split('\n').length} lines`, inline: true },
                { name: 'Reduction', value: `${reduction}%`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#00FF00')
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

        // ALWAYS send file
        const fileName = `compressed_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(compressed), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${compressed.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Compression completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE RENAMER
async function handleRenamer(message, args, statusMsg) {
    if (!GROQ_API_KEY) {
        return statusMsg.edit('GROQ_API_KEY not configured');
    }

    await statusMsg.edit('Renaming variables...');

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .renamer <code/URL> or reply to a .lua .txt file');
    }

    // BLOCK LUARMOR
    if (isLuarmor(code)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Error')
            .setDescription('Luarmor is BLOCKED and cannot be renamed')
            .addFields({ name: 'Reason', value: 'Luarmor protection detected', inline: false })
            .setFooter({ text: 'By LPZ Hub Team' });
        return statusMsg.edit({ content: 'Blocked!', embeds: [embed] });
    }

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    const startTime = Date.now();

    try {
        await statusMsg.edit('AI renaming variables...');

        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { 
                    role: 'system', 
                    content: 'Rename obfuscated Lua variables to descriptive names. Keep functionality. Return ONLY the code.' 
                },
                { role: 'user', content: code }
            ],
            temperature: 0.3,
            max_tokens: 8000
        });

        let renamed = response.choices[0].message.content
            .replace(/```lua\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        renamed = `-- Refactored by LPZ AI\n\n${renamed}`;

        stats.total_renames++;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        const pasteResult = await uploadToPastefy(renamed, `renamed_${Date.now()}.lua`);
        if (pasteResult) addUploadRecord(message.author.id, 'renamer', pasteResult.url);

        const loadstring_code = createLoadString(renamed);

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('Renamer')
            .addFields(
                { name: 'Time', value: `${elapsedTime}s`, inline: true },
                { name: 'Lines', value: `${renamed.split('\n').length}`, inline: true },
                { name: 'Size', value: `${(renamed.length / 1024).toFixed(2)}KB`, inline: true }
            )
            .setFooter({ text: 'By LPZ Hub Team' });

        if (pasteResult) {
            embed.addFields({ name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false });
        }

        // Send to DM
        try {
            const dmChannel = await message.author.createDM();
            const dmEmbed = new EmbedBuilder()
                .setColor('#FFD700')
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

        // ALWAYS send file
        const fileName = `renamed_${Date.now()}.lua`;
        const attach = new AttachmentBuilder(Buffer.from(renamed), { name: fileName });
        
        embed.setDescription(`\`\`\`lua\n${renamed.substring(0, 500)}...\n\`\`\``);
        await statusMsg.edit({ content: 'Renaming completed!', embeds: [embed], files: [attach] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE UPLOAD
async function handleUpload(message, args, statusMsg) {
    await statusMsg.edit('Processing upload...');

    if (!checkUploadLimit(message.author.id)) {
        return statusMsg.edit(`Limit of ${MAX_UPLOADS_PER_DAY} uploads per day reached!`);
    }

    let content = '';
    let fileName = `upload_${Date.now()}.lua`;

    // Check if URL
    if (args.length > 0 && args[0].startsWith('http')) {
        await statusMsg.edit('Downloading from URL with wget...');
        try {
            content = await fetchWithWget(args[0]);
        } catch (error) {
            return statusMsg.edit(`Error downloading URL: ${error.message}`);
        }
    } 
    // Check if has attached file
    else if (message.attachments.size > 0) {
        await statusMsg.edit('Downloading file...');
        const attachment = message.attachments.first();
        fileName = attachment.name;
        try {
            const response = await axios.get(attachment.url, { responseType: 'text' });
            content = response.data;
        } catch (error) {
            return statusMsg.edit(`Error downloading file: ${error.message}`);
        }
    }
    // Check if has code in argument
    else if (args.length > 0) {
        content = args.join(' ');
    } else {
        return statusMsg.edit('Use: .upload <URL/file/code>');
    }

    if (!content || content.trim() === '') {
        return statusMsg.edit('Empty content');
    }

    // Upload to Pastefy
    await statusMsg.edit('Uploading to Pastefy...');
    const pasteResult = await uploadToPastefy(content, fileName);
    
    if (!pasteResult) {
        return statusMsg.edit('Error uploading to Pastefy');
    }

    stats.total_uploads++;
    addUploadRecord(message.author.id, 'upload', pasteResult.url);

    const loadstring_code = createLoadString(content);

    const embed = new EmbedBuilder()
        .setColor('#4CAF50')
        .setTitle('Upload')
        .addFields(
            { name: 'File', value: fileName, inline: true },
            { name: 'Lines', value: `${content.split('\n').length}`, inline: true },
            { name: 'Size', value: `${(content.length / 1024).toFixed(2)}KB`, inline: true },
            { name: 'Pastefy', value: `[Link](${pasteResult.url}) | [RAW](${pasteResult.raw})`, inline: false }
        )
        .setFooter({ text: `Uploads left today: ${MAX_UPLOADS_PER_DAY - userUploads[message.author.id].length}` });

    // Send loadstring to DM
    try {
        const dmChannel = await message.author.createDM();
        const dmEmbed = new EmbedBuilder()
            .setColor('#4CAF50')
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

    // ALWAYS send file
    const attach = new AttachmentBuilder(Buffer.from(content), { name: fileName });
    await statusMsg.edit({ content: 'Upload completed!', embeds: [embed], files: [attach] });
}

// HANDLE BF
async function handleBF(message, args, statusMsg) {
    if (!GROQ_API_KEY) {
        return statusMsg.edit('GROQ_API_KEY not configured');
    }

    await statusMsg.edit('Analyzing code...');

    let code = await getCodeFromMessage(message, args);
    if (!code) {
        return statusMsg.edit('Use: .bf <code/URL> or reply to a .lua .txt file');
    }

    // BLOCK LUARMOR
    if (isLuarmor(code)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Error')
            .setDescription('Luarmor is BLOCKED and cannot be analyzed')
            .addFields({ name: 'Reason', value: 'Luarmor protection detected', inline: false })
            .setFooter({ text: 'By LPZ Hub Team' });
        return statusMsg.edit({ content: 'Blocked!', embeds: [embed] });
    }

    try {
        await statusMsg.edit('AI analyzing...');

        const response = await groq.chat.completions.create({
            model: 'mixtral-8x7b-32768',
            messages: [
                { 
                    role: 'system', 
                    content: 'Analyze Lua code concisely. Highlight: main function, possible malware, and improvement suggestions.' 
                },
                { role: 'user', content: code }
            ],
            temperature: 0.7,
            max_tokens: 4000
        });

        const analysis = response.choices[0].message.content;
        stats.total_analysis++;

        const embed = new EmbedBuilder()
            .setColor('#FF6B9D')
            .setTitle('BF - Analysis')
            .setDescription(analysis.substring(0, 4000))
            .setFooter({ text: 'By LPZ Hub Team' });

        await statusMsg.edit({ content: 'Analysis completed!', embeds: [embed] });

    } catch (error) {
        await statusMsg.edit(`Error: ${error.message}`);
    }
}

// HANDLE CONFIG
async function handleConfig(message, args, statusMsg) {
    const userId = message.author.id;
    const config = getUserConfig(userId);

    if (args.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#9370DB')
            .setTitle('Config')
            .addFields(
                { name: 'max_file_size', value: `${(config.max_file_size / 1024 / 1024).toFixed(0)}MB`, inline: true },
                { name: 'deobfuscate_enabled', value: config.deobfuscate_enabled ? '✅' : '❌', inline: true },
                { name: 'rename_variables', value: config.rename_variables ? '✅' : '❌', inline: true },
                { name: 'dump_timeout', value: `${config.dump_timeout}s`, inline: true },
                { name: 'auto_upload', value: config.auto_upload ? '✅' : '❌', inline: true }
            )
            .setFooter({ text: 'Use .config set <key> <value>' });
        
        await statusMsg.edit({ content: 'Configuration:', embeds: [embed] });
        return;
    }

    if (args[0] === 'set' && args.length >= 3) {
        const key = args[1];
        const value = args.slice(2).join(' ');
        
        if (!(key in config)) {
            return statusMsg.edit('Invalid configuration key');
        }

        let newValue = value;
        if (value === 'true') newValue = true;
        else if (value === 'false') newValue = false;
        else if (!isNaN(value)) newValue = Number(value);
        else if (key === 'max_file_size' && value.endsWith('MB')) {
            newValue = parseInt(value) * 1024 * 1024;
        }

        config[key] = newValue;
        saveUserConfig(userId, config);
        
        await statusMsg.edit(`Configuration updated: ${key} = ${key === 'max_file_size' ? (newValue/1024/1024).toFixed(0) + 'MB' : newValue}`);
        return;
    }

    if (args[0] === 'reset') {
        saveUserConfig(userId, DEFAULT_CONFIG);
        await statusMsg.edit('Configuration reset');
        return;
    }

    await statusMsg.edit('Use: .config, .config set <key> <value>, or .config reset');
}

// HANDLE STATS
async function handleStats(message, args, statusMsg) {
    const uptime = Math.floor((Date.now() - stats.start_time) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const today = new Date().setHours(0,0,0,0);
    const todayUploads = Object.values(userUploads)
        .flat()
        .filter(u => u.date === today)
        .length;

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('Statistics')
        .addFields(
            { name: 'Uptime', value: `${hours}h ${minutes}m`, inline: true },
            { name: 'Users', value: `${stats.users_served.length}`, inline: true },
            { name: 'Dumps', value: `${stats.total_dumps}`, inline: true },
            { name: 'Gets', value: `${stats.total_gets}`, inline: true },
            { name: 'Renames', value: `${stats.total_renames}`, inline: true },
            { name: 'Analysis', value: `${stats.total_analysis}`, inline: true },
            { name: 'Detect', value: `${stats.total_detects || 0}`, inline: true },
            { name: 'Decompiles', value: `${stats.total_decompiles || 0}`, inline: true },
            { name: 'Compress', value: `${stats.total_compresses || 0}`, inline: true },
            { name: 'Minify', value: `${stats.total_minifies || 0}`, inline: true },
            { name: 'Uploads', value: `${stats.total_uploads || 0} (${todayUploads}/day)`, inline: true },
            { name: 'Pastes', value: `${stats.total_pastes}`, inline: true }
        )
        .setFooter({ text: 'By LPZ Hub Team' });

    await statusMsg.edit({ content: 'Statistics:', embeds: [embed] });
}

// HANDLE SUPPORTED
async function handleSupported(message, args, statusMsg) {
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Supported Obfuscators')
        .setDescription('List of obfuscators that can be detected:');

    for (const obf of SUPPORTED_OBFUSCATORS) {
        embed.addFields({ 
            name: obf.name, 
            value: obf.description, 
            inline: false 
        });
    }

    embed.addFields({
        name: '⛔ BLOCKED',
        value: 'Luarmor is BLOCKED and not supported',
        inline: false
    });

    await statusMsg.edit({ content: 'Supported obfuscators:', embeds: [embed] });
}

// HANDLE HELP
async function handleHelp(message, args, statusMsg) {
    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('LPZX - Commands')
        .setDescription('**Available commands:**')
        .addFields(
            { name: '.detect <code>', value: 'Detect obfuscator', inline: false },
            { name: '.dump <code>', value: 'Deobfuscate (Luarmor BLOCKED)', inline: false },
            { name: '.decompiler <file>', value: 'Decompile bytecode', inline: false },
            { name: '.get <URL>', value: 'Download URL content using wget', inline: false },
            { name: '.upload <URL/file>', value: 'Upload to Pastefy', inline: false },
            { name: '.renamer <code>', value: 'Rename variables (Luarmor BLOCKED)', inline: false },
            { name: '.bf <code>', value: 'Analyze code (Luarmor BLOCKED)', inline: false },
            { name: '.compress <code>', value: 'Compress (Luarmor BLOCKED)', inline: false },
            { name: '.minify <code>', value: 'Minify (Luarmor BLOCKED)', inline: false },
            { name: '.suported', value: 'List supported obfuscators', inline: false },
            { name: '.stats', value: 'Bot statistics', inline: false },
            { name: '.config', value: 'User configuration', inline: false },
            { name: '.help', value: 'This message', inline: false }
        )
        .addFields({
            name: 'Accepted formats',
            value: '.lua .txt .luac .luc .bytecode',
            inline: false
        })
        .addFields({
            name: 'Limits',
            value: `• Max file size: 20MB\n• Uploads per day: ${MAX_UPLOADS_PER_DAY}\n• Timeout: 30s`,
            inline: false
        })
        .addFields({
            name: '⛔ BLOCKED',
            value: 'Luarmor is BLOCKED in all commands',
            inline: false
        })
        .setFooter({ text: 'By LPZ Hub Team' });

    await statusMsg.edit({ content: 'Help:', embeds: [embed] });
}

// Login
if (!TOKEN) {
    console.error('[ERROR] Discord token not configured!');
    process.exit(1);
}

client.login(TOKEN).catch(error => {
    console.error('[ERROR] Connection error:', error.message);
    process.exit(1);
});

console.log('[BOT] LPZX v4 started!');
console.log(`[BOT] Directory: ${__dirname}`);
console.log(`[BOT] Upload limit: ${MAX_UPLOADS_PER_DAY}/day`);
console.log(`[BOT] Scripts: dumper=${fs.existsSync(DUMPER_PATH)}, decompiler=${fs.existsSync(DECOMPILER_PATH)}, minify=${fs.existsSync(MINIFY_PATH)}`);
console.log('[BOT] Luarmor: BLOCKED in all commands');