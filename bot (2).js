const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');

const TOKEN = '8686276505:AAG6TtJSo5OIyIHWOP7PDXiQ8_pIsC5xb6Q';
const ADMIN_ID = 6814013287;

const bot = new TelegramBot(TOKEN, { polling: true });

const CLIENTS_FILE = '/root/admin-bot/clients.json';

function loadClients() {
  if (!fs.existsSync(CLIENTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
}

function saveClients(clients) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

function run(cmd, timeout = 120000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve(stdout || stderr || err?.message || '');
    });
  });
}

function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

const MENU = `👋 *Admin Bot — Управление VPS*

*Клиенты:*
/clients — список всех клиентов
/add <ссылка\\_github> <имя> — добавить клиента
/pause <имя> — приостановить (не оплатил)
/resume <имя> — возобновить (оплатил)
/remove <имя> — удалить клиента полностью

*Боты:*
/status — статус всех ботов
/restart <имя> — перезапустить бота
/logs <имя> — логи бота
/qr <имя> — получить QR-код

*Сервер:*
/memory — память и диск сервера
/reboot — перезагрузить сервер

/help — показать это меню`;

bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет доступа');
  bot.sendMessage(msg.chat.id, MENU, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, MENU, { parse_mode: 'Markdown' });
});

// ===== СПИСОК КЛИЕНТОВ =====
bot.onText(/\/clients/, (msg) => {
  if (!isAdmin(msg)) return;
  const clients = loadClients();
  const keys = Object.keys(clients);
  if (keys.length === 0) {
    return bot.sendMessage(msg.chat.id, '📋 Клиентов пока нет.\n\nДобавь через:\n/add <ссылка_github> <имя>');
  }
  let text = '📋 *Список клиентов:*\n\n';
  for (const [name, info] of Object.entries(clients)) {
    const status = info.paused ? '🔴 Приостановлен' : '🟢 Активен';
    const date = info.addedAt ? new Date(info.addedAt).toLocaleDateString('ru-RU') : '—';
    text += `*${name}*\n  ${status}\n  Добавлен: ${date}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ===== ДОБАВИТЬ КЛИЕНТА =====
bot.onText(/\/add (\S+) (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const github = match[1].trim();
  const name = match[2].trim().toLowerCase();

  bot.sendMessage(msg.chat.id, `⏳ Добавляю клиента *${name}*...\nЭто займёт 1-2 минуты`, { parse_mode: 'Markdown' });

  const cloneOut = await run(`git clone ${github} /root/${name} 2>&1`);
  if (cloneOut.includes('fatal') || cloneOut.includes('ERROR')) {
    return bot.sendMessage(msg.chat.id, `❌ Ошибка клонирования:\n${cloneOut.slice(0, 500)}`);
  }

  // Переименовываем js файл в bot.js
  const findOut = await run(`find /root/${name} -maxdepth 1 -name "*.js" | head -1`);
  const jsFile = findOut.trim();
  if (jsFile && !jsFile.endsWith('bot.js')) {
    await run(`mv "${jsFile}" /root/${name}/bot.js`);
  }

  bot.sendMessage(msg.chat.id, `📦 Устанавливаю зависимости... (может занять 3-5 минут)`);
  await run(`cd /root/${name} && npm init -y`, 30000);
  await run(`cd /root/${name} && npm install`, 300000);
  await run(`cd /root/${name} && npm install dotenv groq-sdk node-cron moment-timezone whatsapp-web.js qrcode-terminal`, 300000);

  bot.sendMessage(msg.chat.id, `🚀 Запускаю бота...`);
  await run(`pm2 start /root/${name}/bot.js --name ${name}`);
  await run(`pm2 save`);

  const clients = loadClients();
  clients[name] = { github, paused: false, addedAt: new Date().toISOString() };
  saveClients(clients);

  bot.sendMessage(msg.chat.id, `✅ Клиент *${name}* добавлен и запущен!\n\nЧерез 30 секунд используй /qr ${name} чтобы получить QR-код`, { parse_mode: 'Markdown' });
});

// ===== ПРИОСТАНОВИТЬ =====
bot.onText(/\/pause (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();
  const clients = loadClients();
  if (!clients[name]) return bot.sendMessage(msg.chat.id, `❌ Клиент *${name}* не найден`, { parse_mode: 'Markdown' });

  await run(`pm2 stop ${name}`);
  clients[name].paused = true;
  clients[name].pausedAt = new Date().toISOString();
  saveClients(clients);

  bot.sendMessage(msg.chat.id, `🔴 Клиент *${name}* приостановлен\n\nВозобновить: /resume ${name}`, { parse_mode: 'Markdown' });
});

// ===== ВОЗОБНОВИТЬ =====
bot.onText(/\/resume (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();
  const clients = loadClients();
  if (!clients[name]) return bot.sendMessage(msg.chat.id, `❌ Клиент *${name}* не найден`, { parse_mode: 'Markdown' });

  await run(`pm2 start ${name}`);
  clients[name].paused = false;
  clients[name].resumedAt = new Date().toISOString();
  saveClients(clients);

  bot.sendMessage(msg.chat.id, `🟢 Клиент *${name}* возобновлён`, { parse_mode: 'Markdown' });
});

// ===== УДАЛИТЬ КЛИЕНТА =====
bot.onText(/\/remove (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();

  await run(`pm2 delete ${name}`);
  await run(`rm -rf /root/${name}`);
  await run(`pm2 save`);

  const clients = loadClients();
  delete clients[name];
  saveClients(clients);

  bot.sendMessage(msg.chat.id, `🗑 Клиент *${name}* полностью удалён`, { parse_mode: 'Markdown' });
});

// ===== СТАТУС =====
bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg)) return;
  const out = await run('pm2 list --no-color');
  bot.sendMessage(msg.chat.id, `\`\`\`\n${out.slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
});

// ===== ПЕРЕЗАПУСТИТЬ =====
bot.onText(/\/restart (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  await run(`pm2 restart ${name}`);
  bot.sendMessage(msg.chat.id, `🔄 *${name}* перезапущен`, { parse_mode: 'Markdown' });
});

// ===== ЛОГИ =====
bot.onText(/\/logs (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  const out = await run(`pm2 logs ${name} --lines 50 --nostream --no-color`);
  const trimmed = out.slice(-3000);
  bot.sendMessage(msg.chat.id, `\`\`\`\n${trimmed}\n\`\`\``, { parse_mode: 'Markdown' });
});

// ===== QR-КОД =====
bot.onText(/\/qr (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  bot.sendMessage(msg.chat.id, `⏳ Ищу QR-код для *${name}*...`, { parse_mode: 'Markdown' });

  const out = await run(`pm2 logs ${name} --lines 150 --nostream --no-color`);
  const lines = out.split('\n');
  let qrLines = [];
  let inQR = false;

  for (const line of lines) {
    const clean = line.replace(/^.*?\|/, '').trim();
    if (clean.includes('█') || clean.includes('▄') || clean.includes('▀')) {
      inQR = true;
    }
    if (inQR) {
      qrLines.push(clean);
      if (qrLines.length > 50) break;
    }
  }

  if (qrLines.length > 0) {
    bot.sendMessage(msg.chat.id, `\`\`\`\n${qrLines.join('\n')}\n\`\`\`\n\n📱 Сканируй: WhatsApp → Связанные устройства`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ QR-код не найден.\n\nЛибо бот уже подключён, либо ещё загружается — подожди 30 сек и попробуй снова.`);
  }
});

// ===== ПАМЯТЬ =====
bot.onText(/\/memory/, async (msg) => {
  if (!isAdmin(msg)) return;
  const disk = await run(`df -h / | awk 'NR==2{print $3" из "$2" ("$5")"}'`);
  const ram = await run(`free -m | awk 'NR==2{printf "%d MB из %d MB (%.0f%%)", $3, $2, $3*100/$2}'`);
  const uptime = await run(`uptime -p`);
  const load = await run(`cat /proc/loadavg | awk '{print $1, $2, $3}'`);

  bot.sendMessage(msg.chat.id,
    `🖥 *Состояние сервера:*\n\n` +
    `💾 *Диск:* ${disk.trim()}\n` +
    `🧠 *RAM:* ${ram.trim()}\n` +
    `⏱ *Аптайм:* ${uptime.trim()}\n` +
    `📊 *Нагрузка:* ${load.trim()}`,
    { parse_mode: 'Markdown' }
  );
});

// ===== ПЕРЕЗАГРУЗКА СЕРВЕРА =====
bot.onText(/\/reboot/, async (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, `⚠️ Сервер перезагружается...\n\nВсе боты запустятся автоматически через ~1 минуту.`);
  setTimeout(() => run('reboot'), 3000);
});

console.log('🤖 Admin bot запущен и готов к работе');
