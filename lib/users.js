const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(__dirname, '..', 'users.json');

// Crear automáticamente el archivo users.json si no existe
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, '[]', 'utf8');
}

function loadUsers() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

function getUser(telegram_id) {
  return new Promise((resolve) => {
    let users = loadUsers();
    let user = users.find(u => u.telegram_id == telegram_id);
    if (!user) {
      user = {
        telegram_id,
        whatsapp_number: "",
        is_admin: telegram_id === 7223378630 ? 1 : 0
      };
      users.push(user);
      saveUsers(users);
    }
    resolve(user);
  });
}

function updateUserWhatsapp(telegram_id, number) {
  return new Promise((resolve) => {
    let users = loadUsers();
    // Primero verificamos si el número ya está en uso
    let existing = users.find(u => u.whatsapp_number === number);
    if (existing) {
      // Si el número ya está en uso por otro usuario, lo limpiamos
      if (existing.telegram_id !== telegram_id) {
        existing.whatsapp_number = "";
      }
    }
    
    let user = users.find(u => u.telegram_id == telegram_id);
    if (user) {
      // Actualizamos el número del usuario actual
      user.whatsapp_number = number;
      user.last_connected = new Date().toISOString();
      saveUsers(users);
    }
    resolve(user);
  });
}

async function clearUserWhatsapp(telegram_id) {
  return new Promise((resolve) => {
    let users = loadUsers();
    let user = users.find(u => u.telegram_id == telegram_id);
    if (user) {
      user.whatsapp_number = "";
      saveUsers(users);
    }
    resolve();
  });
}

async function isWhatsappConnected(telegram_id) {
  return new Promise((resolve) => {
    db.get('SELECT whatsapp_number FROM users WHERE telegram_id = ?', [telegram_id], (err, row) => {
      if (err || !row || !row.whatsapp_number) resolve(false);
      else {
        const pairingDir = path.join(__dirname, '..', 'lib', 'pairing', String(telegram_id), row.whatsapp_number);
        const credsPath = path.join(pairingDir, 'creds.json');
        resolve(fs.existsSync(credsPath));
      }
    });
  });
}

function isActive(user) {
  return true; // Ahora todos los usuarios están activos
}

// Declaración del objeto db
const db = {
  all: (query, params, cb) => {
    const localUsers = loadUsers(); // Usar variable local
    const filtered = localUsers.filter(u => u.whatsapp_number && u.whatsapp_number !== "");
    cb(null, filtered);
  }
};

// Cambiar exports al final
module.exports = {
  getUser,
  updateUserWhatsapp, 
  clearUserWhatsapp,
  isActive,
  db,
  isWhatsappConnected
};