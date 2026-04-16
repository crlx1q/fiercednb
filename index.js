const { Client, GatewayIntentBits, ActivityType, SlashCommandBuilder, EmbedBuilder, PermissionsBitField, Partials } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const scdl = require('soundcloud-downloader').default;
const play = require('play-dl');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- НАСТРОЙКИ ИИ ---
// ВАЖНО: Храните ваш API ключ в безопасности и не публикуйте его. Лучше использовать переменные окружения.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YOUR_DISCORD_ID = '860615756286525481';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
const chatHistories = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
});

// --- НАСТРОЙКИ AFK ---
const AFK_CHANNEL_ID = '988383566901694514';
const GUILD_ID = '921418037628907550';
const IGNORE_USER_ID = '860615756286525481';

const AFK_TIMEOUTS = {
    MUTED_ALONE: 60 * 60 * 1000,
    MUTED_WITH_OTHERS: 2 * 60 * 60 * 1000,
    UNMUTED_ALONE: 3 * 60 * 60 * 1000,
    DEAFENED: 60 * 60 * 1000,
};

const afkTrackedUsers = new Map();

// --- ПЕРЕМЕННЫЕ МУЗЫКАЛЬНОГО БОТА ---
let connection;
let player;
let loop = false;
let queue = [];
let currentTrack = null;
const startTime = Date.now();
const voiceChannelId = '1183904036743815309';

// --- СЛЕШ-КОМАНДЫ ---
const playCommand = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Воспроизводит песню с SoundCloud или YouTube')
    .addStringOption(option =>
        option.setName('запрос')
            .setDescription('Название песни или URL')
            .setRequired(true)
    );

const stopCommand = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Останавливает воспроизведение и отключает бота');

const loopCommand = new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Включает/выключает повтор');

const queueCommand = new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Показывает очередь треков');

const uptimeCommand = new SlashCommandBuilder()
    .setName('uptime')
    .setDescription('Показывает время работы бота');

const playlistCommand = new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Добавляет плейлист с SoundCloud или YouTube в очередь')
    .addStringOption(option =>
        option.setName('запрос')
            .setDescription('URL плейлиста')
            .setRequired(true)
    );

const nextCommand = new SlashCommandBuilder()
    .setName('next')
    .setDescription('Пропускает текущий трек и воспроизводит следующий');

const skipCommand = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Пропускает текущий трек и воспроизводит следующий трек из очереди');

const afkCommand = new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Перемещает пользователя в AFK канал')
    .addUserOption(option =>
        option.setName('пользователь')
            .setDescription('Выберите пользователя для перемещения')
            .setRequired(true)
    );

client.on('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    client.user.setPresence({
        activities: [{ name: '69', type: ActivityType.Listening }],
        status: 'dnd'
    });

    try {
        await client.application.commands.set([
            playCommand,
            stopCommand,
            loopCommand,
            queueCommand,
            uptimeCommand,
            playlistCommand,
            nextCommand,
            skipCommand,
            afkCommand
        ]);
        console.log('Слеш-команды успешно зарегистрированы.');
    } catch (error) {
        console.error('Ошибка при регистрации слеш-команд:', error);
    }

    connectToVoiceChannel();
    setInterval(() => {
        if (!connection || connection.state.status === 'destroyed') {
            connectToVoiceChannel();
        }
    }, 60 * 1000);

    setInterval(checkAfkUsers, 60 * 1000);
});

// --- ОБРАБОТЧИК СООБЩЕНИЙ ДЛЯ ИИ (ИСПРАВЛЕНА ЛОГИКА ИСТОРИИ) ---
client.on('messageCreate', async message => {
    if (message.author.bot || message.guild) return;
    if (message.author.id !== YOUR_DISCORD_ID) return;

    try {
        await message.channel.sendTyping();

        // --- ИСПРАВЛЕНО: УПРАВЛЕНИЕ ИСТОРИЕЙ ЧАТА ---
        const userId = message.author.id;
        // Получаем историю или создаем новую, если ее нет.
        let userHistory = chatHistories.get(userId) || [];

        const parts = [];
        const promptText = message.content;

        // Обработка изображений
        if (message.attachments.size > 0) {
            const fetch = (await import('node-fetch')).default;
            for (const attachment of message.attachments.values()) {
                if (attachment.contentType?.startsWith('image/')) {
                    const response = await fetch(attachment.url);
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    parts.push({
                        inlineData: {
                            mimeType: attachment.contentType,
                            data: buffer.toString('base64'),
                        },
                    });
                }
            }
        }
        
        if (promptText) {
            parts.push({ text: promptText });
        }

        // Добавляем текущее сообщение пользователя в его историю
        userHistory.push({ role: "user", parts });

        // --- ИСПРАВЛЕНИЕ: Ограничиваем историю ПЕРЕД отправкой в модель ---
        const historyForModel = userHistory.slice(-6); // Берем последние 6 сообщений

        const result = await model.generateContent({ 
            contents: historyForModel, // Отправляем корректно обрезанную историю
            tools: [{ 'google_search': {} }]
        });
        const response = await result.response;
        const text = response.text();

        // Добавляем ответ модели в историю для поддержания контекста
        userHistory.push({ role: "model", parts: [{ text }] });

        // --- ИСПРАВЛЕНИЕ: Снова обрезаем основную историю и сохраняем ее ---
        if (userHistory.length > 6) {
            userHistory = userHistory.slice(-6);
        }
        chatHistories.set(userId, userHistory);

        // Отправляем ответ, разбивая на части, если он слишком длинный
        if (text.length > 2000) {
            const responseParts = text.match(/[\s\S]{1,2000}/g) || [];
            for (const part of responseParts) {
                await message.reply(part);
            }
        } else {
            await message.reply(text);
        }

    } catch (error) {
        console.error("Ошибка при обработке сообщения для ИИ:", error);
        await message.reply("Произошла ошибка при обращении к ИИ. Попробуйте еще раз позже.");
    }
});


client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // --- ОБРАБОТКА КОМАНДЫ /AFK ---
    if (interaction.commandName === 'afk') {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
            return interaction.editReply({ content: 'У вас нет прав для перемещения пользователей.' });
        }

        const member = interaction.options.getMember('пользователь');
        if (!member) {
            return interaction.editReply({ content: 'Пользователь не найден.' });
        }

        if (!member.voice.channel) {
            return interaction.editReply({ content: 'Этот пользователь не находится в голосовом канале.' });
        }

        if (member.id === IGNORE_USER_ID) {
            return interaction.editReply({ content: 'Этого пользователя нельзя переместить.' });
        }

        try {
            await member.voice.setChannel(AFK_CHANNEL_ID);
            await interaction.editReply({ content: `Пользователь ${member.user.tag} был перемещен в AFK канал.` });
        } catch (error) {
            console.error('Ошибка при перемещении пользователя:', error);
            await interaction.editReply({ content: 'Не удалось переместить пользователя. Проверьте, существует ли AFK канал и есть ли у меня права.' });
        }
        return;
    }

    // --- ОБРАБОТКА МУЗЫКАЛЬНЫХ КОМАНД ---
    if (interaction.commandName === 'play') {
        const query = interaction.options.getString('запрос');
        await interaction.deferReply({ ephemeral: true });

        try {
            await addToQueue(interaction, query);
        } catch (error) {
            console.error('Error adding track to queue:', error);
            await interaction.editReply({ content: 'Произошла ошибка при добавлении трека в очередь.' });
        }
    } else if (interaction.commandName === 'stop') {
        if (player) {
            player.stop();
            if (connection) {
                connection.destroy();
                connection = null;
            }
            queue = [];
            currentTrack = null;
            await interaction.reply({ content: 'Воспроизведение остановлено, бот покинул канал.', ephemeral: true });
        } else {
            await interaction.reply({ content: 'Сейчас ничего не играет.', ephemeral: true });
        }
    } else if (interaction.commandName === 'loop') {
        loop = !loop;
        await interaction.reply({ content: `Повтор ${loop ? 'включен' : 'выключен'}.`, ephemeral: true });
    } else if (interaction.commandName === 'queue') {
        await showQueue(interaction);
    } else if (interaction.commandName === 'uptime') {
        const uptime = getUptime();
        await interaction.reply({ content: `Бот работает уже: ${uptime}`, ephemeral: true });
    } else if (interaction.commandName === 'playlist') {
        const query = interaction.options.getString('запрос');
        await interaction.deferReply({ ephemeral: true });

        try {
            await addPlaylistToQueue(interaction, query);
        } catch (error) {
            console.error('Error adding playlist to queue:', error);
            await interaction.editReply({ content: 'Произошла ошибка при добавлении плейлиста в очередь.' });
        }
    } else if (interaction.commandName === 'next' || interaction.commandName === 'skip') {
        await skipTrack(interaction);
    }
});

// --- ЛОГИКА АВТОМАТИЧЕСКОГО AFK ---
client.on('voiceStateUpdate', (oldState, newState) => {
    const member = newState.member;
    if (member.user.bot || member.id === IGNORE_USER_ID) return;

    if (!newState.channelId || newState.channelId === AFK_CHANNEL_ID) {
        afkTrackedUsers.delete(member.id);
        return;
    }

    if (newState.channelId && newState.channelId !== AFK_CHANNEL_ID) {
        afkTrackedUsers.set(member.id, {
            guildId: newState.guild.id,
            channelId: newState.channelId,
            startTime: Date.now(),
            lastState: {
                deaf: newState.serverDeaf || newState.selfDeaf,
                mute: newState.serverMute || newState.selfMute,
                alone: newState.channel.members.size === 1
            }
        });
    }
});

async function checkAfkUsers() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const now = Date.now();

    for (const [userId, data] of afkTrackedUsers.entries()) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.voice.channel || member.voice.channel.id === AFK_CHANNEL_ID) {
            afkTrackedUsers.delete(userId);
            continue;
        }

        const voiceState = member.voice;
        const isDeaf = voiceState.serverDeaf || voiceState.selfDeaf;
        const isMute = voiceState.serverMute || voiceState.selfMute;
        const isAlone = voiceState.channel.members.size === 1;

        let timeout;
        let reason = '';

        if (isDeaf) {
            timeout = AFK_TIMEOUTS.DEAFENED;
            reason = 'отключил звук и микрофон';
        } else if (isMute) {
            if (isAlone) {
                timeout = AFK_TIMEOUTS.MUTED_ALONE;
                reason = 'один в канале с выключенным микрофоном';
            } else {
                timeout = AFK_TIMEOUTS.MUTED_WITH_OTHERS;
                reason = 'в канале с другими с выключенным микрофоном';
            }
        } else if (isAlone) {
            timeout = AFK_TIMEOUTS.UNMUTED_ALONE;
            reason = 'один в канале с включенным микрофоном';
        }

        if (timeout && (now - data.startTime >= timeout)) {
            try {
                await member.voice.setChannel(AFK_CHANNEL_ID, `Перемещен за неактивность (${reason})`);
                console.log(`Пользователь ${member.user.tag} перемещен в AFK.`);
                afkTrackedUsers.delete(userId);
            } catch (error) {
                console.error(`Не удалось переместить ${member.user.tag}:`, error);
            }
        }
    }
}

// --- ФУНКЦИИ МУЗЫКАЛЬНОГО БОТА ---
async function addToQueue(interaction, query) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.editReply({ content: 'Вы должны сначала присоединиться к голосовому каналу!' });
    }

    const tracks = await getTrackInfo(query);
    queue.push(...tracks);

    await interaction.editReply({ content: `Трек добавлен в очередь: ${tracks.map(track => track.title).join(', ')}` });

    if (!currentTrack) {
        playNextTrack(interaction);
    }
}

async function addPlaylistToQueue(interaction, query) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.editReply({ content: 'Вы должны сначала присоединиться к голосовому каналу!' });
    }

    const tracks = await getPlaylistInfo(query);
    queue.push(...tracks);

    await interaction.editReply({ content: `Плейлист добавлен в очередь: ${tracks.map(track => track.title).join(', ')}` });

    if (!currentTrack) {
        playNextTrack(interaction);
    }
}

async function getTrackInfo(query) {
    if (scdl.isValidUrl(query)) {
        const info = await scdl.getInfo(query);
        return [{
            title: info.title,
            url: info.permalink_url,
            duration: formatDuration(info.duration / 1000),
            type: 'soundcloud',
        }];
    } else if (play.yt_validate(query) === 'video') {
        const videoInfo = await play.video_info(query);
        const info = videoInfo.video_details;
        return [{
            title: info.title,
            url: info.url,
            duration: info.durationRaw,
            type: 'youtube',
        }];
    } else {
        const searchResults = await play.search(query, { limit: 1 });
        if (searchResults.length > 0) {
            const track = searchResults[0];
            return [{
                title: track.title,
                url: track.url,
                duration: track.durationRaw,
                type: 'youtube',
            }];
        } else {
            throw new Error('По вашему запросу ничего не найдено.');
        }
    }
}

async function getPlaylistInfo(query) {
    if (play.yt_validate(query) === 'playlist') {
        const playlist = await play.playlist_info(query, { incomplete: true });
        await playlist.fetch();
        return playlist.videos.map(video => ({
            title: video.title,
            url: video.url,
            duration: video.durationRaw,
            type: 'youtube',
        }));
    } else if (scdl.isValidUrl(query) && query.includes('/sets/')) {
        const playlistInfo = await scdl.getSetInfo(query);
        return playlistInfo.tracks.map(track => ({
            title: track.title,
            url: track.permalink_url,
            duration: formatDuration(track.duration / 1000),
            type: 'soundcloud',
        }));
    } else {
        throw new Error('Неверная ссылка на плейлист SoundCloud или YouTube.');
    }
}

function formatDuration(seconds) {
    if (isNaN(seconds)) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function playNextTrack(interaction) {
    if (queue.length === 0) {
        if (loop && currentTrack) {
            queue.push(currentTrack);
        } else {
            currentTrack = null;
            return;
        }
    }

    const track = queue.shift();
    currentTrack = track;

    if (!connection || connection.state.status === 'destroyed') {
        try {
            connection = joinVoiceChannel({
                channelId: interaction.member.voice.channel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
        } catch (e) {
            console.error("Не удалось подключиться к голосовому каналу:", e);
            return;
        }
    }

    if (!player || player.state.status === AudioPlayerStatus.Idle) {
        player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            playNextTrack(interaction);
        });

        player.on('error', error => {
            console.error('Ошибка воспроизведения:', error);
            interaction.followUp({ content: 'Произошла ошибка во время воспроизведения.', ephemeral: true }).catch(console.error);
            playNextTrack(interaction);
        });
    }

    try {
        let stream;
        if (track.type === 'soundcloud') {
            stream = await scdl.download(track.url);
        } else {
            const ytStream = await play.stream(track.url);
            stream = ytStream.stream;
        }

        const resource = createAudioResource(stream);
        player.play(resource);

    } catch (error) {
        console.error('Ошибка получения стрима для трека:', error);
        playNextTrack(interaction);
    }
}

async function showQueue(interaction) {
    if (queue.length === 0 && !currentTrack) {
        await interaction.reply({ content: 'Очередь пуста.', ephemeral: true });
        return;
    }

    const queueList = queue.map((track, index) => `${index + 1}. ${track.title} (${track.duration})`).join('\n');
    const nowPlaying = currentTrack ? `**Сейчас играет:** ${currentTrack.title} (${currentTrack.duration})\n\n` : '';

    const embed = new EmbedBuilder()
        .setTitle('Очередь треков')
        .setDescription(nowPlaying + queueList)
        .setColor('#FF0000');

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function skipTrack(interaction) {
    if (!player) {
        return interaction.reply({ content: 'Сейчас ничего не играет.', ephemeral: true });
    }

    player.stop(); // Это вызовет событие 'idle', которое запустит следующий трек
    await interaction.reply({ content: `Трек пропущен.`, ephemeral: true });
}

function getUptime() {
    const now = Date.now();
    const diff = now - startTime;

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    return `${days} дней, ${hours} часов, ${minutes} минут, ${seconds} секунд`;
}

function connectToVoiceChannel() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log(`Сервер с ID ${GUILD_ID} не найден.`);
        return;
    }
    const voiceChannel = guild.channels.cache.get(voiceChannelId);

    if (voiceChannel) {
        try {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            console.log(`Музыкальный бот подключился к каналу: ${voiceChannel.name}`);
        } catch (error) {
            console.error("Ошибка при подключении музыкального бота:", error);
        }
    } else {
        console.log(`Голосовой канал для музыки с ID ${voiceChannelId} не найден.`);
    }
}

// ВАШ ТОКЕН
client.login('MTMwNzAwNzc1MTk0NzU1NDg0Ng.G-_u1i.aAqnL9pG5racuxqv3dXAx0NaMxXedEGSN7bFXE');
