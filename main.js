const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const NodeCache = require('node-cache');
const simple = require('./lib/oke.js');
const smsg = require('./lib/smsg.js');
const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, makeInMemoryStore, jidDecode, proto, getContentType, downloadContentFromMessage, makeCacheableSignalKeyStore } = require('baron-baileys-v2');
const { getUser, updateUserWhatsapp, clearUserWhatsapp, isActive, db, loadUsers } = require('./lib/users.js');
const dotenv = require('dotenv');

const TOKEN = process.env.BOT_TOKEN || '8291086232:AAEPlgnr-3SI7Wi2mWqNSz582S-lSgeqO1w'; // Usa .env
const bot = new TelegramBot(TOKEN, { polling: true });

const activeSessions = {};
const userStates = {};

// Modificar variables globales de reconexión
const maxRetries = 10;
const sessions = new Map();
const retryDelays = new Map();

async function startSession(telegram_id, number) {
    const sessionId = `${telegram_id}-${number}`;
    let retryCount = retryDelays.get(sessionId) || 0;
    const sessionPath = path.join(__dirname, 'lib', 'pairing', String(telegram_id), number);

    if (activeSessions[telegram_id]) {
        return activeSessions[telegram_id];
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const store = makeInMemoryStore({
        logger: pino().child({
            level: 'silent',
            stream: 'store'
        })
    });

    const conn = simple({
        logger: pino({
            level: 'silent'
        }),
        printQRInTerminal: false,
        auth: state,
        version: [2, 3000, 1023223821],
        browser: Browsers.ubuntu("Edge"),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 2000,
        phoneCheckOnCallback: true,
        emitOwnEvents: false,
        getMessage: async key => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || proto.Message.fromObject({});
            }
            return proto.Message.fromObject({});
        }
    });

    store.bind(conn.ev);

    if (!conn.authState.creds.registered) {
        setTimeout(async () => {
            let code = await conn.requestPairingCode(number);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            fs.writeFileSync(path.join(sessionPath, 'pairing.json'), JSON.stringify({ code }, null, 2));
        }, 1700);
    }

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            // Manejo de errores críticos que requieren limpieza de sesión
            if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.loggedOut) {
                console.log(`[❌] Error crítico de sesión (${statusCode}) para ${number}. Limpiando sesión y notificando al usuario.`);
                await cleanSession(telegram_id, true); // Limpiar y notificar
                return;
            }

            if (shouldReconnect && retryCount < maxRetries) {
                retryCount++;
                retryDelays.set(sessionId, retryCount);
                const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
                console.log(`[🔄] Reintentando conexión para ${number} en ${delay / 1000}s... (Intento ${retryCount}/${maxRetries})`);
                setTimeout(() => startSession(telegram_id, number), delay);
            } else if (retryCount >= maxRetries) {
                console.log(`[❌] Máximo de reintentos alcanzado para ${number}. Limpiando sesión.`);
                await cleanSession(telegram_id, true); // Limpiar y notificar
                delete activeSessions[telegram_id];
                retryDelays.delete(sessionId);
            } else {
                console.log(`[❌] Sesión cerrada para ${number}. Razón: ${lastDisconnect?.error?.message}`);
                delete activeSessions[telegram_id];
            }
        } else if (connection === 'open') {
            console.log(`[✅] Conexión abierta para ${number}`);
            retryDelays.delete(sessionId);
            activeSessions[telegram_id] = conn;
        }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async chatUpdate => {
        const mek = chatUpdate.messages[0];
        if (!mek.message) return;
        mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;
        if (mek.key && mek.key.remoteJid === 'status@broadcast') return;
        if (!conn.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
        if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;
        const m = smsg(conn, mek, store);
        require("./baron.js")(conn, m, chatUpdate, store);
    });

    return conn;
}

async function cleanSession(telegram_id, notifyUser = false) {
    if (activeSessions[telegram_id]) {
        try {
            await activeSessions[telegram_id].logout();
        } catch {}
        delete activeSessions[telegram_id];
    }
    const user = await getUser(telegram_id);

    if (user && user.whatsapp_number) {
        const sessionPath = path.join(__dirname, 'lib', 'pairing', String(telegram_id));
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[🧹] Sesión de ${user.whatsapp_number} limpia.`);
        }
    }
    await clearUserWhatsapp(telegram_id);

    if (notifyUser) {
        try {
            await bot.sendMessage(telegram_id, 'Tu sesión de WhatsApp se ha corrompido o cerrado.\n\nHa sido eliminada para proteger tu cuenta. Por favor, vuelve a conectar tu número usando el menú.');
        } catch (e) {
            console.error(`[❌] No se pudo notificar al usuario ${telegram_id} sobre la limpieza de sesión.`);
        }
    }
}

(async () => {
  console.log('\n[⚡] Iniciando reconexión de sesiones...\n');
  
  try {
    // Restaurar sesiones VIP
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM users WHERE whatsapp_number != ""', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    for (const user of users) {
            const sessionPath = path.join(__dirname, 'lib', 'pairing', String(user.telegram_id), user.whatsapp_number);
            const credsPath = path.join(sessionPath, 'creds.json');
            if (fs.existsSync(credsPath)) {
                console.log(`[🔄] Restaurando sesión: ${user.telegram_id}/${user.whatsapp_number}`);
                await startSession(Number(user.telegram_id), user.whatsapp_number);
            }
        }
  } catch (err) {
    console.error('\n[❌] Error en proceso de inicio:', err);
  }
})();

const chocoplus = require('./chocoplus.js');
chocoplus(bot, {
    userStates,
    activeSessions,
    cleanSession,
    startSession
});

// Mensaje final de inicio
console.log('Telegram x Baileys conectado com sucesso');
let file = require.resolve(__filename)
fs.watchFile(file, () => {
fs.unwatchFile(file)
console.log(`Update ${__filename}`)
delete require.cache[file]
require(file)
})


// Exportar startSession para otros módulos si es necesario
module.exports = { startSession, cleanSession, userStates, activeSessions };