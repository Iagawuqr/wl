/**
 * Lua Dumper Discord Bot v2.0
 * Comandos: .l .get .renamer .config .bf
 * Desenvolvido em Node.js com discord.js
 */

const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ==================== CONFIGURAÇÕES ====================

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY;
const CONFIG_DIR = './user_configs';

// Criar diretório de configs se não existir
if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// User-Agents do Roblox
const ROBLOX_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Roblox/WinInet',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36 Roblox',
    'Roblox/WinInet Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
];

// Configurações padrão
const DEFAULT_CONFIG = {
    max_file_size: 8388608, // 8MB
    deobfuscate_enabled: true,
    rename_variables: true,
    preserve_comments: true,
    output_format: 'lua',
    theme: 'dark'
};

// ==================== CLIENTE DISCORD ====================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

// ==================== EVENTOS ====================

client.on('ready', () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
    client.user.setActivity('.help para ajuda', { type: 'WATCHING' });
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('.')) return;
    if (message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'l':
                await handleDeobfuscate(message, args);
                break;
            case 'get':
                await handleGet(message, args);
                break;
            case 'renamer':
                await handleRenamer(message, args);
                break;
            case 'config':
                await handleConfig(message, args);
                break;
            case 'bf':
                await handleBF(message, args);
                break;
            case 'help':
                await handleHelp(message);
                break;
            default:
                break;
        }
    } catch (error) {
        console.error(`Erro: ${error.message}`);
        await message.reply({
            content: `❌ Erro: ${error.message}`,
            ephemeral: true
        }).catch(() => {});
    }
});

// ==================== FUNÇÕES UTILITÁRIAS ====================

/**
 * Obter configuração do usuário
 */
function getUserConfig(userId) {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            return DEFAULT_CONFIG;
        }
    }
    return DEFAULT_CONFIG;
}

/**
 * Salvar configuração do usuário
 */
function saveUserConfig(userId, config) {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Obter conteúdo de URL com Roblox User-Agent
 */
async function fetchWithRobloxUA(url) {
    const ua = ROBLOX_USER_AGENTS[Math.floor(Math.random() * ROBLOX_USER_AGENTS.length)];
    
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': ua,
                'Accept': '*/*'
            },
            timeout: 15000,
            maxRedirects: 5
        });
        return response.data;
    } catch (error) {
        throw new Error(`Erro ao acessar URL: ${error.message}`);
    }
}

/**
 * Desofuscar código Lua
 */
function deobfuscateLua(code) {
    let result = code;
    let varMap = {};
    let counter = 1;

    // Encontrar variáveis simples (a, b, c, etc)
    const varPattern = /local\s+([a-z])\s*=/gi;
    result = result.replace(varPattern, (match, varName) => {
        if (!varMap[varName]) {
            varMap[varName] = `var_${counter++}`;
        }
        return `local ${varMap[varName]} =`;
    });

    // Substituir referências
    Object.entries(varMap).forEach(([old, newName]) => {
        const pattern = new RegExp(`\\b${old}\\b`, 'g');
        result = result.replace(pattern, newName);
    });

    // Formatar indentação
    result = result.split('\n').map(line => {
        const indent = line.match(/^\s*/)[0].length;
        const content = line.trim();
        return content ? '    '.repeat(Math.floor(indent / 4)) + content : '';
    }).join('\n');

    return result;
}

/**
 * Renomear variáveis usando API xAI
 */
async function renameVariablesWithXAI(code) {
    if (!XAI_API_KEY) {
        throw new Error('XAI_API_KEY não configurada');
    }

    try {
        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
            model: 'grok-2',
            messages: [
                {
                    role: 'system',
                    content: 'Você é um especialista em refatoração de código Lua. Renomeie as variáveis para nomes descritivos e legíveis. Retorne APENAS o código refatorado, sem explicações.'
                },
                {
                    role: 'user',
                    content: `Renomeie as variáveis deste código Lua para nomes descritivos e legíveis:\n\n\`\`\`lua\n${code}\n\`\`\``
                }
            ],
            max_tokens: 2000,
            temperature: 0.3
        }, {
            headers: {
                'Authorization': `Bearer ${XAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        throw new Error(`Erro na API xAI: ${error.message}`);
    }
}

/**
 * Chamar API xAI (Grok)
 */
async function callXAI(code, prompt) {
    if (!XAI_API_KEY) {
        throw new Error('XAI_API_KEY não configurada');
    }

    try {
        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
            model: 'grok-2',
            messages: [
                {
                    role: 'system',
                    content: 'Você é um especialista em análise de código Lua. Analise o código e forneça insights.'
                },
                {
                    role: 'user',
                    content: `${prompt}\n\n\`\`\`lua\n${code}\n\`\`\``
                }
            ],
            max_tokens: 1000,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${XAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        throw new Error(`Erro na API xAI: ${error.message}`);
    }
}

/**
 * Formatar código para Discord
 */
function formatCode(code, maxLength = 2000) {
    if (code.length > maxLength) {
        return null; // Retornar null para enviar como arquivo
    }
    return `\`\`\`lua\n${code}\n\`\`\``;
}

// ==================== HANDLERS DE COMANDOS ====================

/**
 * Comando: .l
 * Desofuscar código Lua
 */
async function handleDeobfuscate(message, args) {
    const userId = message.author.id;
    const config = getUserConfig(userId);

    if (!config.deobfuscate_enabled) {
        return message.reply('❌ Desofuscação desativada. Use `.config set deobfuscate_enabled true`');
    }

    let code = null;

    // Verificar se é resposta a arquivo
    if (message.reference) {
        try {
            const replied = await message.channel.messages.fetch(message.reference.message_id);
            if (replied.attachments.size > 0) {
                const attachment = replied.attachments.first();
                if (attachment.name.endsWith('.lua') || attachment.name.endsWith('.txt')) {
                    code = await axios.get(attachment.url).then(r => r.data);
                }
            }
        } catch (error) {
            console.error('Erro ao obter arquivo:', error);
        }
    }

    // Se não houver código, verificar argumentos
    if (!code) {
        if (args.length === 0) {
            return message.reply('❌ Use: `.l <código>` ou `.l <URL>` ou responda a um arquivo');
        }

        const input = args.join(' ');

        // Se for URL
        if (input.startsWith('http://') || input.startsWith('https://')) {
            try {
                await message.react('⏳');
                code = await fetchWithRobloxUA(input);
            } catch (error) {
                await message.reactions.removeAll().catch(() => {});
                return message.reply(`❌ ${error.message}`);
            }
        } else {
            code = input;
        }
    }

    // Verificar tamanho
    if (code.length > config.max_file_size) {
        return message.reply(`❌ Código muito grande (máximo ${config.max_file_size} bytes)`);
    }

    try {
        await message.react('⏳');
        const deobfuscated = deobfuscateLua(code);
        
        const formatted = formatCode(deobfuscated);
        
        if (formatted) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Código Desofuscado')
                .setDescription(formatted)
                .setFooter({ text: `Solicitado por ${message.author.username}` });
            
            await message.reply({ embeds: [embed] });
        } else {
            const buffer = Buffer.from(deobfuscated, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'deobfuscated.lua' });
            await message.reply({
                content: '✅ Código desofuscado (arquivo)',
                files: [attachment]
            });
        }
        
        await message.reactions.removeAll().catch(() => {});
        await message.react('✅');
    } catch (error) {
        await message.reactions.removeAll().catch(() => {});
        await message.reply(`❌ Erro: ${error.message}`);
    }
}

/**
 * Comando: .get
 * Capturar conteúdo de URL com Roblox User-Agent
 */
async function handleGet(message, args) {
    if (args.length === 0) {
        return message.reply('❌ Use: `.get <URL>`');
    }

    const url = args.join(' ');

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return message.reply('❌ URL inválida');
    }

    try {
        await message.react('⏳');
        const content = await fetchWithRobloxUA(url);
        
        const formatted = formatCode(content);
        
        if (formatted) {
            const embed = new EmbedBuilder()
                .setColor('#0099FF')
                .setTitle('📥 Conteúdo Capturado')
                .setDescription(formatted)
                .setFooter({ text: `URL: ${url}` });
            
            await message.reply({ embeds: [embed] });
        } else {
            const buffer = Buffer.from(content, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'content.txt' });
            await message.reply({
                content: '📥 Conteúdo capturado (arquivo)',
                files: [attachment]
            });
        }
        
        await message.reactions.removeAll().catch(() => {});
        await message.react('✅');
    } catch (error) {
        await message.reactions.removeAll().catch(() => {});
        await message.reply(`❌ ${error.message}`);
    }
}

/**
 * Comando: .renamer
 * Renomear variáveis usando API xAI
 */
async function handleRenamer(message, args) {
    if (!XAI_API_KEY) {
        return message.reply('❌ XAI_API_KEY não configurada');
    }

    const userId = message.author.id;
    const config = getUserConfig(userId);

    if (!config.rename_variables) {
        return message.reply('❌ Renomeação desativada. Use `.config set rename_variables true`');
    }

    let code = null;

    // Verificar se é resposta a arquivo
    if (message.reference) {
        try {
            const replied = await message.channel.messages.fetch(message.reference.message_id);
            if (replied.attachments.size > 0) {
                const attachment = replied.attachments.first();
                if (attachment.name.endsWith('.lua') || attachment.name.endsWith('.txt')) {
                    code = await axios.get(attachment.url).then(r => r.data);
                }
            }
        } catch (error) {
            console.error('Erro ao obter arquivo:', error);
        }
    }

    // Se não houver código, verificar argumentos
    if (!code) {
        if (args.length === 0) {
            return message.reply('❌ Use: `.renamer <código>` ou `.renamer <URL>` ou responda a um arquivo');
        }

        const input = args.join(' ');

        // Se for URL
        if (input.startsWith('http://') || input.startsWith('https://')) {
            try {
                await message.react('⏳');
                code = await fetchWithRobloxUA(input);
            } catch (error) {
                await message.reactions.removeAll().catch(() => {});
                return message.reply(`❌ ${error.message}`);
            }
        } else {
            code = input;
        }
    }

    // Verificar tamanho
    if (code.length > 5000) {
        return message.reply('❌ Código muito grande para renomeação (máximo 5000 caracteres)');
    }

    try {
        await message.react('⏳');
        const renamed = await renameVariablesWithXAI(code);
        
        const formatted = formatCode(renamed);
        
        if (formatted) {
            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('📝 Variáveis Renomeadas (xAI)')
                .setDescription(formatted)
                .setFooter({ text: `Solicitado por ${message.author.username}` });
            
            await message.reply({ embeds: [embed] });
        } else {
            const buffer = Buffer.from(renamed, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'renamed.lua' });
            await message.reply({
                content: '📝 Variáveis renomeadas (arquivo)',
                files: [attachment]
            });
        }
        
        await message.reactions.removeAll().catch(() => {});
        await message.react('✅');
    } catch (error) {
        await message.reactions.removeAll().catch(() => {});
        await message.reply(`❌ ${error.message}`);
    }
}

/**
 * Comando: .config
 * Gerenciar configurações do usuário
 */
async function handleConfig(message, args) {
    const userId = message.author.id;
    const config = getUserConfig(userId);

    if (args.length === 0) {
        // Mostrar configurações
        const embed = new EmbedBuilder()
            .setColor('#9370DB')
            .setTitle('⚙️ Suas Configurações')
            .addFields(
                { name: 'max_file_size', value: `${config.max_file_size} bytes`, inline: true },
                { name: 'deobfuscate_enabled', value: config.deobfuscate_enabled ? '✅' : '❌', inline: true },
                { name: 'rename_variables', value: config.rename_variables ? '✅' : '❌', inline: true },
                { name: 'preserve_comments', value: config.preserve_comments ? '✅' : '❌', inline: true },
                { name: 'output_format', value: config.output_format, inline: true },
                { name: 'theme', value: config.theme, inline: true }
            )
            .setFooter({ text: 'Use .config set <chave> <valor> para alterar' });
        
        return message.reply({ embeds: [embed] });
    }

    const subcommand = args[0].toLowerCase();

    if (subcommand === 'set' && args.length >= 3) {
        const key = args[1];
        const value = args.slice(2).join(' ');

        if (!(key in config)) {
            return message.reply(`❌ Configuração inválida: ${key}`);
        }

        // Converter tipo
        let newValue = value;
        if (value === 'true') newValue = true;
        else if (value === 'false') newValue = false;
        else if (!isNaN(value)) newValue = Number(value);

        config[key] = newValue;
        saveUserConfig(userId, config);

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Configuração Atualizada')
            .addFields(
                { name: 'Chave', value: key, inline: true },
                { name: 'Valor', value: String(newValue), inline: true }
            );
        
        return message.reply({ embeds: [embed] });
    }

    if (subcommand === 'reset') {
        saveUserConfig(userId, DEFAULT_CONFIG);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Configurações Resetadas')
            .setDescription('Todas as configurações foram restauradas para o padrão');
        
        return message.reply({ embeds: [embed] });
    }

    message.reply('❌ Use: `.config` ou `.config set <chave> <valor>` ou `.config reset`');
}

/**
 * Comando: .bf
 * Análise com API xAI (Grok) + Sugestões de Renomeação
 */
async function handleBF(message, args) {
    if (!XAI_API_KEY) {
        return message.reply('❌ XAI_API_KEY não configurada');
    }

    let code = null;

    // Verificar se é resposta a arquivo
    if (message.reference) {
        try {
            const replied = await message.channel.messages.fetch(message.reference.message_id);
            if (replied.attachments.size > 0) {
                const attachment = replied.attachments.first();
                if (attachment.name.endsWith('.lua') || attachment.name.endsWith('.txt')) {
                    code = await axios.get(attachment.url).then(r => r.data);
                }
            }
        } catch (error) {
            console.error('Erro ao obter arquivo:', error);
        }
    }

    // Se não houver código, verificar argumentos
    if (!code) {
        if (args.length === 0) {
            return message.reply('❌ Use: `.bf <código>` ou `.bf <URL>` ou responda a um arquivo');
        }

        const input = args.join(' ');

        // Se for URL
        if (input.startsWith('http://') || input.startsWith('https://')) {
            try {
                await message.react('⏳');
                code = await fetchWithRobloxUA(input);
            } catch (error) {
                await message.reactions.removeAll().catch(() => {});
                return message.reply(`❌ ${error.message}`);
            }
        } else {
            code = input;
        }
    }

    if (code.length > 5000) {
        return message.reply('❌ Código muito grande para análise (máximo 5000 caracteres)');
    }

    try {
        await message.react('⏳');
        
        // Fazer análise
        const analysis = await callXAI(code, 'Analise este código Lua e forneça insights sobre o que ele faz, possíveis melhorias e segurança.');
        
        // Obter sugestões de renomeação
        const renamed = await renameVariablesWithXAI(code);
        
        // Criar embed com análise e renomeação
        const embed = new EmbedBuilder()
            .setColor('#FF6B9D')
            .setTitle('🤖 Análise xAI (Grok) + Renomeação')
            .addFields(
                {
                    name: '📊 Análise',
                    value: analysis.length > 1024 ? analysis.substring(0, 1021) + '...' : analysis,
                    inline: false
                },
                {
                    name: '📝 Código Renomeado',
                    value: `\`\`\`lua\n${renamed.substring(0, 500)}${renamed.length > 500 ? '\n...\n\`\`\`' : '\n\`\`\`'}`,
                    inline: false
                }
            )
            .setFooter({ text: `Solicitado por ${message.author.username}` });
        
        await message.reply({ embeds: [embed] });
        
        // Se o código renomeado for muito grande, enviar como arquivo
        if (renamed.length > 2000) {
            const buffer = Buffer.from(renamed, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'renamed_full.lua' });
            await message.reply({
                content: '📝 Código completo renomeado:',
                files: [attachment]
            });
        }
        
        await message.reactions.removeAll().catch(() => {});
        await message.react('✅');
    } catch (error) {
        await message.reactions.removeAll().catch(() => {});
        await message.reply(`❌ ${error.message}`);
    }
}

/**
 * Comando: .help
 * Mostrar ajuda
 */
async function handleHelp(message) {
    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('📚 Ajuda - Lua Dumper Bot')
        .setDescription('Comandos disponíveis:')
        .addFields(
            {
                name: '`.l <código/URL/arquivo>`',
                value: 'Desofuscar código Lua',
                inline: false
            },
            {
                name: '`.get <URL>`',
                value: 'Capturar conteúdo de URL com Roblox User-Agent',
                inline: false
            },
            {
                name: '`.renamer <código/URL/arquivo>`',
                value: 'Renomear variáveis para código legível',
                inline: false
            },
            {
                name: '`.config`',
                value: 'Ver/alterar configurações\n`.config set <chave> <valor>`\n`.config reset`',
                inline: false
            },
            {
                name: '`.bf <código/URL/arquivo>`',
                value: 'Análise com IA xAI (Grok)',
                inline: false
            },
            {
                name: '`.help`',
                value: 'Mostrar esta mensagem',
                inline: false
            }
        )
        .setFooter({ text: `Solicitado por ${message.author.username}` });

    await message.reply({ embeds: [embed] });
}

// ==================== INICIALIZAÇÃO ====================

if (!TOKEN) {
    console.error('❌ DISCORD_BOT_TOKEN não configurado!');
    process.exit(1);
}

client.login(TOKEN).catch((error) => {
    console.error('❌ Erro ao conectar:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Erro não tratado:', error);
});

module.exports = { client };
