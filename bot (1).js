'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { exec }    = require('child_process');
const fs          = require('fs');
const path        = require('path');
const QRCode      = require('qrcode');
const FormData    = require('form-data');
const fetch       = require('node-fetch');

// ─── КОНФИГ ───────────────────────────────────────────────────────────────────
const TOKEN    = '8686276505:AAG6TtJSo5OIyIHWOP7PDXiQ8_pIsC5xb6Q';
const ADMIN_ID = 6814013287;
const CLIENTS_FILE = path.join(__dirname, 'clients.json');

// ─── ХРАНИЛИЩЕ КЛИЕНТОВ ───────────────────────────────────────────────────────
function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveClients(data) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2));
}

// ─── ВЫПОЛНИТЬ КОМАНДУ ────────────────────────────────────────────────────────
function run(cmd, timeout = 120000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve((stdout || stderr || err?.message || '').trim());
    });
  });
}

// ─── ОТПРАВИТЬ QR КАК КАРТИНКУ ───────────────────────────────────────────────
async function sendQRPhoto(chatId, qrData, caption) {
  const tmpFile = `/tmp/qr_${Date.now()}.png`;
  await QRCode.toFile(tmpFile, qrData, { width: 512, margin: 2 });
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', fs.createReadStream(tmpFile));
  form.append('caption', caption);
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });
  fs.unlinkSync(tmpFile);
}

// ─── БОТ ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

function deny(msg) {
  bot.sendMessage(msg.chat.id, '⛔ Нет доступа');
}

const MENU = `👋 *Admin Bot — Управление VPS*

*Клиенты:*
/clients — список всех клиентов
/add <github> <имя> — добавить клиента
/pause <имя> — приостановить (не оплатил)
/resume <имя> — возобновить (оплатил)
/remove <имя> — удалить клиента полностью

*Боты:*
/status — статус всех ботов
/restart <имя> — перезапустить бота
/logs <имя> — логи бота
/qr <имя> — получить QR-код картинкой

*Сервер:*
/memory — память и диск сервера
/reboot — перезагрузить сервер

/help — показать это меню`;

// ─── /start и /help ───────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  if (!isAdmin(msg)) return deny(msg);
  bot.sendMessage(msg.chat.id, MENU, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, msg => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, MENU, { parse_mode: 'Markdown' });
});

// ─── /clients ─────────────────────────────────────────────────────────────────
bot.onText(/\/clients/, msg => {
  if (!isAdmin(msg)) return;
  const clients = loadClients();
  const keys = Object.keys(clients);
  if (!keys.length) {
    return bot.sendMessage(msg.chat.id, '📋 Клиентов пока нет.\n\nДобавь: /add <github> <имя>');
  }
  let text = '📋 *Список клиентов:*\n\n';
  for (const [name, info] of Object.entries(clients)) {
    const status = info.paused ? '🔴 Приостановлен' : '🟢 Активен';
    const date   = info.addedAt ? new Date(info.addedAt).toLocaleDateString('ru-RU') : '—';
    text += `*${name}*\n  ${status}\n  Добавлен: ${date}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ─── /add <github> <имя> ──────────────────────────────────────────────────────
bot.onText(/\/add (\S+) (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const github = match[1].trim();
  const name   = match[2].trim().toLowerCase();
  const dir    = `/root/${name}`;

  bot.sendMessage(msg.chat.id, `⏳ Добавляю *${name}*...\nЭто займёт 2-5 минут`, { parse_mode: 'Markdown' });

  // Клонируем
  const cloneOut = await run(`git clone ${github} ${dir} 2>&1`);
  if (cloneOut.includes('fatal') || cloneOut.includes('ERROR')) {
    return bot.sendMessage(msg.chat.id, `❌ Ошибка клонирования:\n${cloneOut.slice(0, 400)}`);
  }

  // Переименовываем любой .js файл в bot.js
  const jsFile = (await run(`find ${dir} -maxdepth 1 -name "*.js" | head -1`)).trim();
  if (jsFile && !jsFile.endsWith('/bot.js')) {
    await run(`mv "${jsFile}" ${dir}/bot.js`);
  }

  // Патчим бота — вставляем отправку QR картинкой в Telegram
  const botCode = fs.readFileSync(`${dir}/bot.js`, 'utf8');
  const patchedCode = botCode.replace(
    /wa\.on\('qr',\s*(async\s*)?\(qr\)\s*=>\s*\{/,
    `wa.on('qr', async (qr) => {
  // Отправляем QR картинкой в Telegram
  try {
    const _QR   = require('qrcode');
    const _FD   = require('form-data');
    const _ft   = require('node-fetch');
    const _tmp  = require('os').tmpdir() + '/qr_${name}.png';
    await _QR.toFile(_tmp, qr, { width: 512, margin: 2 });
    const _form = new _FD();
    _form.append('chat_id', '${ADMIN_ID}');
    _form.append('photo', require('fs').createReadStream(_tmp));
    _form.append('caption', '📱 QR-код для *${name}*\\nСканируй: WhatsApp → Связанные устройства');
    await _ft('https://api.telegram.org/bot${TOKEN}/sendPhoto', { method: 'POST', body: _form, headers: _form.getHeaders() });
  } catch(_e) { console.log('QR send error:', _e.message); }`
  );
  fs.writeFileSync(`${dir}/bot.js`, patchedCode);

  // Устанавливаем зависимости
  bot.sendMessage(msg.chat.id, `📦 Устанавливаю зависимости...`);
  await run(`cd ${dir} && npm init -y`, 30000);
  await run(`cd ${dir} && npm install`, 300000);
  await run(`cd ${dir} && npm install dotenv groq-sdk node-cron moment-timezone whatsapp-web.js qrcode-terminal qrcode form-data node-fetch@2`, 300000);

  // Запускаем
  bot.sendMessage(msg.chat.id, `🚀 Запускаю бота...`);
  await run(`pm2 start ${dir}/bot.js --name ${name}`);
  await run(`pm2 save`);

  // Сохраняем клиента
  const clients = loadClients();
  clients[name] = { github, paused: false, addedAt: new Date().toISOString() };
  saveClients(clients);

  bot.sendMessage(msg.chat.id, `✅ Клиент *${name}* добавлен!\n\nQR-код придёт сюда автоматически через 30-60 секунд 📱`, { parse_mode: 'Markdown' });
});

// ─── /pause <имя> ─────────────────────────────────────────────────────────────
bot.onText(/\/pause (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();
  const clients = loadClients();
  if (!clients[name]) return bot.sendMessage(msg.chat.id, `❌ Клиент *${name}* не найден`, { parse_mode: 'Markdown' });

  await run(`pm2 stop ${name}`);
  clients[name].paused   = true;
  clients[name].pausedAt = new Date().toISOString();
  saveClients(clients);
  bot.sendMessage(msg.chat.id, `🔴 *${name}* приостановлен (не оплатил)\n\nВозобновить: /resume ${name}`, { parse_mode: 'Markdown' });
});

// ─── /resume <имя> ────────────────────────────────────────────────────────────
bot.onText(/\/resume (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();
  const clients = loadClients();
  if (!clients[name]) return bot.sendMessage(msg.chat.id, `❌ Клиент *${name}* не найден`, { parse_mode: 'Markdown' });

  await run(`pm2 start ${name}`);
  clients[name].paused    = false;
  clients[name].resumedAt = new Date().toISOString();
  saveClients(clients);
  bot.sendMessage(msg.chat.id, `🟢 *${name}* возобновлён`, { parse_mode: 'Markdown' });
});

// ─── /remove <имя> ────────────────────────────────────────────────────────────
bot.onText(/\/remove (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim().toLowerCase();

  await run(`pm2 delete ${name}`);
  await run(`rm -rf /root/${name}`);
  await run(`pm2 save`);

  const clients = loadClients();
  delete clients[name];
  saveClients(clients);
  bot.sendMessage(msg.chat.id, `🗑 *${name}* удалён полностью`, { parse_mode: 'Markdown' });
});

// ─── /status ──────────────────────────────────────────────────────────────────
bot.onText(/\/status/, async msg => {
  if (!isAdmin(msg)) return;
  const out = await run('pm2 list --no-color');
  bot.sendMessage(msg.chat.id, `\`\`\`\n${out.slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
});

// ─── /restart <имя> ───────────────────────────────────────────────────────────
bot.onText(/\/restart (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  await run(`pm2 restart ${name}`);
  bot.sendMessage(msg.chat.id, `🔄 *${name}* перезапущен`, { parse_mode: 'Markdown' });
});

// ─── /logs <имя> ──────────────────────────────────────────────────────────────
bot.onText(/\/logs (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  const out  = await run(`pm2 logs ${name} --lines 50 --nostream --no-color`);
  bot.sendMessage(msg.chat.id, `\`\`\`\n${out.slice(-3000)}\n\`\`\``, { parse_mode: 'Markdown' });
});

// ─── /qr <имя> — вытащить QR из логов и отправить картинкой ──────────────────
bot.onText(/\/qr (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const name = match[1].trim();
  bot.sendMessage(msg.chat.id, `⏳ Ищу QR для *${name}*...`, { parse_mode: 'Markdown' });

  // Читаем лог файл напрямую
  const logFile = `/root/.pm2/logs/${name}-out.log`;
  const out = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8')
    : await run(`pm2 logs ${name} --lines 200 --nostream --no-color`);

  // Ищем QR данные (whatsapp-web.js логирует qr в консоль)
  const lines = out.split('\n');
  let qrData = null;

  // Ищем строку с QR данными (длинная base64-подобная строка)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^.*?\|/, '').trim();
    // QR данные whatsapp выглядят как длинная строка с запятыми
    if (line.length > 50 && line.includes(',') && !line.includes(' ') && !line.startsWith('/') && !line.startsWith('(')) {
      qrData = line;
      break;
    }
  }

  if (qrData) {
    try {
      await sendQRPhoto(msg.chat.id, qrData, `📱 QR-код для ${name}\nСканируй: WhatsApp → Связанные устройства`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Не удалось создать картинку: ${e.message}`);
    }
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ QR-код не найден в логах.\n\nВозможно бот уже подключён или ещё загружается.\nПодожди 30 сек и попробуй снова.`);
  }
});

// ─── /memory ──────────────────────────────────────────────────────────────────
bot.onText(/\/memory/, async msg => {
  if (!isAdmin(msg)) return;
  const disk   = await run(`df -h / | awk 'NR==2{print $3" из "$2" ("$5")"}'`);
  const ram    = await run(`free -m | awk 'NR==2{printf "%d MB из %d MB (%.0f%%)", $3, $2, $3*100/$2}'`);
  const uptime = await run(`uptime -p`);
  const load   = await run(`cat /proc/loadavg | awk '{print $1, $2, $3}'`);

  bot.sendMessage(msg.chat.id,
    `🖥 *Состояние сервера:*\n\n` +
    `💾 *Диск:* ${disk}\n` +
    `🧠 *RAM:* ${ram}\n` +
    `⏱ *Аптайм:* ${uptime}\n` +
    `📊 *Нагрузка:* ${load}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /reboot ──────────────────────────────────────────────────────────────────
bot.onText(/\/reboot/, async msg => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, `⚠️ Сервер перезагружается...\n\nВсе боты запустятся автоматически через ~1 минуту.`);
  setTimeout(() => run('reboot'), 3000);
});

console.log('🤖 Admin bot запущен и готов к работе');
