require('dotenv/config');
const fs = require('fs');
const path = require('path');

global.prefa = ['','!','.',',',';'] 

fs.watchFile(__filename, () => {
  fs.unwatchFile(__filename);
  console.log(`Update ${__filename}`);
  delete require.cache[__filename];
  require(__filename);
});

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN, 
  ADMIN_IDS: process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(id => Number(id.trim()))
    : [7223378630] 
};

module.exports = { config };