const { default: makeWASocket, DisconnectReason, makeInMemoryStore, jidDecode, Browsers, proto, getContentType, useMultiFileAuthState, downloadContentFromMessage } = require('baron-baileys-v2');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const readline = require('readline');
const _ = require('lodash');
const FileType = require('file-type');
const path = require('path');
const PhoneNumber = require('awesome-phonenumber');
const simple = require('./lib/oke.js');
const smsg = require('./lib/smsg.js');
const { isUrl, generateMessageTag, getBuffer, getSizeMedia, fetchJson: fetch, sleep } = require('./lib/myfunc.js');

// __dirname y __filename ya están disponibles en CommonJS, no es necesario definirlos.

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => { rl.question(text, resolve) });
};

const sessions = new Map();
const userSessions = new Map();

async function startpairing(phoneNumber, sessionPath) {
  async function WhatsAppStart() {
    const {state, saveCreds} = await useMultiFileAuthState(sessionPath);
    
    // Nueva configuración de almacenamiento
    const store = makeInMemoryStore({ 
      logger: pino({ level: "fatal" }).child({ level: "fatal" }),
      cleanStaleMessages: true,
      maxCommitRetries: 10,
      delayBetweenRetriesMs: 500
    });

    // Sistema de reconexión mejorado
    let retryCount = 0;
    const maxRetries = 10;
    
    const conn = simple({
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      // Actualiza la versión para corregir el error de conexión
      version: [2, 3000, 1023223821],
      browser: Browsers.ubuntu("Edge"),
      // Agregar retry y timeout
      retryRequestDelayMs: 2000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      maxQRAttempts: 3,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000,
      phoneCheckOnCallback: true,
      emitOwnEvents: false,
      getMessage: async key => {
        try {
          const msg = await store.loadMessage(key.remoteJid, key.id);
          return msg?.message || '';
        } catch (err) {
          console.error(err);
          return '';
        }
      }
    }, store);

    if (!conn.authState.creds.registered) {
      setTimeout(async () => {
        let code = await conn.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        // Guarda el código en la carpeta específica de la sesión
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
        fs.writeFileSync(path.join(sessionPath, 'pairing.json'), JSON.stringify({ code }, null, 2));
      }, 1700);
    }
    
    store.bind(conn.ev);
    
    conn.ev.on('messages.upsert', async chatUpdate => {
      try {
        const mek = chatUpdate.messages[0];
        if (!mek.message) return;
        mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;
        if (mek.key && mek.key.remoteJid === 'status@broadcast') return;
        if (!conn.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
        if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;
        
        const m = smsg(conn, mek, store);
        const bruxin = require("./baron.js"); // No se necesita .default
        bruxin(conn, m, chatUpdate, store);
      } catch (err) {
        console.log(err);
      }
    });

    // Setting
    conn.decodeJid = (jid) => {
      if (!jid) return jid
      if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {}
        return decode.user && decode.server && decode.user + '@' + decode.server || jid
      } else return jid
    }

    conn.getName = (jid, withoutContact= false) => {
      id = conn.decodeJid(jid)
      withoutContact = conn.withoutContact || withoutContact 
      let v
      if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
        v = store.contacts[id] || {}
        if (!(v.name || v.subject)) v = conn.groupMetadata(id) || {}
        resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
      })
      else v = id === '0@s.whatsapp.net' ? {
        id,
        name: 'WhatsApp'
      } : id === conn.decodeJid(conn.user.id) ?
      conn.user :
      (store.contacts[id] || {})
      return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    conn.public = true
    conn.serializeM = (m) => smsg(conn, m, store);
    conn.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && retryCount < maxRetries) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
          console.log(`Reintentando conexión en ${delay/1000}s... (Intento ${retryCount}/${maxRetries})`);
          
          setTimeout(async () => {
            await WhatsAppStart();
          }, delay);
        } else if (retryCount >= maxRetries) {
          console.log('Máximo de intentos alcanzado, limpiando sesión...');
          // Limpiar sesión y credenciales
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }
      } else if (connection === 'open') {
        retryCount = 0;
        console.log('Conexión establecida');
        
        // Limpieza periódica de pre-keys
        setInterval(async () => {
          try {
            const { creds } = conn.authState;
            if (creds.registered) {
              creds.keys = creds.keys.filter(k => {
                const age = Date.now() - (k.timestamp || 0);
                return age < (24 * 60 * 60 * 1000); // 24h
              });
              await saveCreds();
            }
          } catch (err) {
            console.error('Error en limpieza de pre-keys:', err);
          }
        }, 3600000); // Cada hora
      }
    });

    // Monitor del sistema cada 5 minutos
    setInterval(() => {
      const heapUsed = process.memoryUsage().heapUsed / 1024 / 1024;
      if (heapUsed > 800) {
        console.warn('Sistema sobrecargado, iniciando limpieza...');
        global.gc && global.gc();
      }
    }, 300000);

    conn.ev.on('creds.update', saveCreds)

    async function getMessage(key) {
      if (store) {
        const msg = await store.loadMessage(key.remoteJid, key.id)
        return msg
      }
      return {
        conversation: "NekoBot"
      }
    }
    /*
    conn.ev.on('messages.update', 
    async(chatUpdate) => {
      for (const { key, update } of chatUpdate) {
        if (update.pollUpdates && key.fromMe) {
           const pollCreation = await getMessage(key);
           if (pollCreation) {
           let pollUpdate = await getAggregateVotesInPollMessage({
    message: pollCreation?.message,
    pollUpdates: update.pollUpdates,
    });
    let toCmd = pollUpdate.filter(v => v.voters.length !== 0)[0]?.name
    console.log(toCmd);
    await appenTextMessage(m, conn, toCmd, pollCreation);
    await conn.sendMessage(m.cht, { delete: key });
           } else return false
    return
         }
       }
    });
    */

    conn.sendText = (jid, text, quoted = '', options) => conn.sendMessage(jid, { text: text, ...options }, { quoted })
//=========================================\\
conn.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
let quoted = message.msg ? message.msg : message
let mime = (message.msg || message).mimetype || ''
let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
const stream = await downloadContentFromMessage(quoted, messageType)
let buffer = Buffer.from([])
for await(const chunk of stream) {
buffer = Buffer.concat([buffer, chunk])
}
let type = await FileType.fromBuffer(buffer)
let trueFileName = attachExtension ? ('./sticker/' + filename + '.' + type.ext) : './sticker/' + filename
// save to file
await fs.writeFileSync(trueFileName, buffer)
return trueFileName
}
//=========================================\\
conn.getFile = async (PATH, save) => {
let res
let data = Buffer.isBuffer(PATH) ? PATH : /^data:.*?\/.*?;base64,/i.test(PATH) ? Buffer.from(PATH.split`,`[1], 'base64') : /^https?:\/\//.test(PATH) ? await (res = await getBuffer(PATH)) : fs.existsSync(PATH) ? (filename = PATH, fs.readFileSync(PATH)) : typeof PATH === 'string' ? PATH : Buffer.alloc(0)
//if (!Buffer.isBuffer(data)) throw new TypeError('Result is not a buffer')
let type = await FileType.fromBuffer(data) || {
mime: 'application/octet-stream',
ext: '.bin'
}
filename = path.join(__dirname, '../src/' + new Date * 1 + '.' + type.ext)
if (data && save) fs.promises.writeFile(filename, data)
return {
res,
filename,
size: await getSizeMedia(data),
...type,
data
}
}

conn.sendFile = async (jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) => {
let type = await conn.getFile(path, true);
let { res, data: file, filename: pathFile } = type;

if (res && res.status !== 200 || file.length <= 65536) {
try {
throw {
json: JSON.parse(file.toString())
};
} catch (e) {
if (e.json) throw e.json;
}
}

let opt = {
filename
};

if (quoted) opt.quoted = quoted;
if (!type) options.asDocument = true;

let mtype = '',
mimetype = type.mime,
convert;

if (/webp/.test(type.mime) || (/image/.test(type.mime) && options.asSticker)) mtype = 'sticker';
else if (/image/.test(type.mime) || (/webp/.test(type.mime) && options.asImage)) mtype = 'image';
else if (/video/.test(type.mime)) mtype = 'video';
else if (/audio/.test(type.mime)) {
convert = await (ptt ? toPTT : toAudio)(file, type.ext);
file = convert.data;
pathFile = convert.filename;
mtype = 'audio';
mimetype = 'audio/ogg; codecs=opus';
} else mtype = 'document';

if (options.asDocument) mtype = 'document';

delete options.asSticker;
delete options.asLocation;
delete options.asVideo;
delete options.asDocument;
delete options.asImage;

let message = { ...options, caption, ptt, [mtype]: { url: pathFile }, mimetype };
let m;

try {
m = await conn.sendMessage(jid, message, { ...opt, ...options });
} catch (e) {
//console.error(e)
m = null;
} finally {
if (!m) m = await conn.sendMessage(jid, { ...message, [mtype]: file }, { ...opt, ...options });
file = null;
return m;
}
}

conn.sendTextWithMentions = async (jid, text, quoted, options = {}) => conn.sendMessage(jid, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })
//=========================================\\
conn.downloadMediaMessage = async (message) => {
let mime = (message.msg || message).mimetype || ''
let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
const stream = await downloadContentFromMessage(message, messageType)
let buffer = Buffer.from([])
for await(const chunk of stream) {
buffer = Buffer.concat([buffer, chunk])
}
return buffer
}
return conn
}
WhatsAppStart()
}

module.exports = startpairing;

// Watcher
const file = __filename;
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(`Update ${file}`);
  process.exit(0); // Reiniciar proceso al actualizar
});