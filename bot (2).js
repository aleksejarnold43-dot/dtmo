/**
 * ============================================================
 *  BARBERSHOP WHATSAPP BOT
 *  Стек: whatsapp-web.js + Groq API (llama-3.3-70b-versatile)
 * ============================================================
 *
 *  УСТАНОВКА:
 *    npm install whatsapp-web.js qrcode-terminal express qrcode groq-sdk
 *
 *  ЗАПУСК:
 *    node bot.js
 *
 *  QR-КОД: откройте http://localhost:3000 в браузере
 * ============================================================
 */

// ─────────────────────────────────────────────
//  КОНФИГ — МЕНЯЙТЕ ТОЛЬКО ЗДЕСЬ
// ─────────────────────────────────────────────
const CONFIG = {
  groqApiKey:    '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',
  ownerNumber:   '79994699526@c.us',       // номер владельца
  webPort:       3000,

  business: {
    name:    'BarberShop',
    phone:   '+7 999 469-95-26',
    address: 'г. Алматы, ул. Примерная, д. 1',
    hours:   '09:00–22:00 ежедневно',
    services: [
      { name: 'Стрижка',        price: 3000, duration: 45 },
      { name: 'Борода',         price: 2000, duration: 30 },
      { name: 'Комплекс',       price: 4500, duration: 75 },
      { name: 'Укладка',        price: 1000, duration: 20 },
    ],
    workStart: 9,    // час открытия
    workEnd:   22,   // час закрытия
    slotMinutes: 45, // шаг слота в минутах
  },

  masters: [
    { name: 'Азамат', specialization: 'классические стрижки, борода',            days: ['Пн','Вт','Ср','Чт','Пт'] },
    { name: 'Данияр', specialization: 'фейды, скин-фейды, современные стрижки',  days: ['Пн','Ср','Пт','Сб','Вс'] },
    { name: 'Руслан', specialization: 'детские стрижки, борода, комплекс',        days: ['Вт','Чт','Сб','Вс'] },
  ],
};
// ─────────────────────────────────────────────

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode    = require('qrcode-terminal');
const QRCode    = require('qrcode');
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const Groq      = require('groq-sdk');

// ── Groq ──────────────────────────────────────
const groq = new Groq({ apiKey: CONFIG.groqApiKey });

// ── Пути к файлам данных ──────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const CLIENTS_FILE  = path.join(DATA_DIR, 'clients.json');
const LOGS_FILE     = path.join(DATA_DIR, 'logs.json');
const BANNED_FILE   = path.join(DATA_DIR, 'banned.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Вспомогательные функции для файлов ────────
function readJSON(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function appendLog(entry) {
  const logs = readJSON(LOGS_FILE, []);
  logs.push({ ts: new Date().toISOString(), ...entry });
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  writeJSON(LOGS_FILE, logs);
}

// ── In-memory состояние ───────────────────────
let botEnabled      = true;
let currentQR       = null;
let botConnected    = false;
const spamMap       = new Map(); // номер → timestamp последнего ответа
const conversations = new Map(); // номер → история сообщений (последние 20)

// ── WhatsApp Client ───────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// ── Express веб-сервер (QR) ───────────────────
const app = express();
app.get('/', async (req, res) => {
  if (botConnected) {
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Bot Status</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;
      justify-content:center;height:100vh;margin:0;background:#f0fdf4;}
      .box{text-align:center;padding:40px;border-radius:16px;background:#fff;
      box-shadow:0 4px 20px rgba(0,0,0,.1);}
      h1{color:#16a34a;font-size:2rem;margin:0 0 8px}
      p{color:#555;margin:0}</style></head><body>
      <div class="box"><h1>✅ Бот подключён</h1>
      <p>${CONFIG.business.name} — WhatsApp Bot работает</p></div>
      </body></html>`);
  }
  if (!currentQR) {
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Bot QR</title>
      <meta http-equiv="refresh" content="5">
      <style>body{font-family:sans-serif;display:flex;align-items:center;
      justify-content:center;height:100vh;margin:0;background:#fafafa;}
      .box{text-align:center;padding:40px;}</style></head><body>
      <div class="box"><h2>⏳ Генерация QR-кода...</h2>
      <p>Страница обновится автоматически</p></div>
      </body></html>`);
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Scan QR</title>
      <meta http-equiv="refresh" content="30">
      <style>body{font-family:sans-serif;display:flex;align-items:center;
      justify-content:center;height:100vh;margin:0;background:#fafafa;}
      .box{text-align:center;padding:40px;border-radius:16px;background:#fff;
      box-shadow:0 4px 20px rgba(0,0,0,.1);}
      img{border:4px solid #1d4ed8;border-radius:8px;margin:16px 0}
      h2{color:#1d4ed8}</style></head><body>
      <div class="box">
        <h2>📱 Отсканируйте QR-код в WhatsApp</h2>
        <img src="${qrDataUrl}" alt="QR">
        <p style="color:#888;font-size:13px">Страница обновляется каждые 30 сек</p>
      </div></body></html>`);
  } catch(e) {
    res.send('<h2>Ошибка генерации QR</h2>');
  }
});
app.listen(CONFIG.webPort, () => {
  console.log(`🌐 Веб-сервер запущен: http://localhost:${CONFIG.webPort}`);
});

// ── QR событие ────────────────────────────────
client.on('qr', qr => {
  currentQR = qr;
  qrcode.generate(qr, { small: true });
  console.log(`📱 QR обновлён. Откройте http://localhost:${CONFIG.webPort}`);
});

client.on('ready', () => {
  botConnected = true;
  currentQR    = null;
  console.log('✅ WhatsApp бот подключён!');
  appendLog({ event: 'BOT_READY' });
  scheduleJobs();
});

client.on('disconnected', reason => {
  botConnected = false;
  console.log('❌ Бот отключён:', reason);
  appendLog({ event: 'BOT_DISCONNECTED', reason });
});

// ═══════════════════════════════════════════════
//  БАЗА ДАННЫХ — ХЕЛПЕРЫ
// ═══════════════════════════════════════════════

function getBookings() { return readJSON(BOOKINGS_FILE, []); }
function saveBookings(b) { writeJSON(BOOKINGS_FILE, b); }

function getClients() { return readJSON(CLIENTS_FILE, {}); }
function saveClients(c) { writeJSON(CLIENTS_FILE, c); }

function getBanned() { return readJSON(BANNED_FILE, []); }
function saveBanned(b) { writeJSON(BANNED_FILE, b); }

function getClient(phone) {
  const all = getClients();
  return all[phone] || null;
}
function upsertClient(phone, data) {
  const all = getClients();
  all[phone] = { ...( all[phone] || {} ), ...data, updatedAt: new Date().toISOString() };
  saveClients(all);
  return all[phone];
}

function getBookingsForDate(dateStr) {
  return getBookings().filter(b => b.date === dateStr && b.status !== 'cancelled');
}

function isSlotBusy(master, dateStr, timeStr) {
  return getBookings().some(b =>
    b.master === master &&
    b.date   === dateStr &&
    b.time   === timeStr &&
    b.status !== 'cancelled'
  );
}

// Генерация всех слотов дня для мастера
function generateSlots(master, dateStr) {
  const slots = [];
  const d = new Date(dateStr + 'T00:00:00');
  const dayNames = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const dayName  = dayNames[d.getDay()];
  const m = CONFIG.masters.find(x => x.name === master);
  if (!m || !m.days.includes(dayName)) return [];

  let cur = CONFIG.business.workStart * 60;
  const end = CONFIG.business.workEnd   * 60;
  while (cur + CONFIG.business.slotMinutes <= end) {
    const hh = String(Math.floor(cur / 60)).padStart(2, '0');
    const mm = String(cur % 60).padStart(2, '0');
    slots.push(`${hh}:${mm}`);
    cur += CONFIG.business.slotMinutes;
  }
  return slots;
}

function getFreeSlots(master, dateStr) {
  return generateSlots(master, dateStr).filter(t => !isSlotBusy(master, dateStr, t));
}

// Топ-3 ближайших свободных слота по всем мастерам
function getTop3FreeSlots() {
  const result = [];
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 7 && result.length < 3; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    for (const master of CONFIG.masters) {
      const slots = getFreeSlots(master.name, dateStr);
      for (const t of slots) {
        if (result.length >= 3) break;
        // не предлагать прошедшие слоты сегодня
        if (dayOffset === 0) {
          const [hh, mm] = t.split(':').map(Number);
          if (hh * 60 + mm <= now.getHours() * 60 + now.getMinutes()) continue;
        }
        result.push({ master: master.name, date: dateStr, time: t });
      }
      if (result.length >= 3) break;
    }
  }
  return result;
}

function dateLabel(dateStr) {
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dayNames = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];
  const d = new Date(dateStr + 'T00:00:00');
  if (dateStr === today)    return 'сегодня';
  if (dateStr === tomorrow) return 'завтра';
  return `${dayNames[d.getDay()]} ${d.getDate()}.${String(d.getMonth()+1).padStart(2,'0')}`;
}

// Сохранить запись
function createBooking(bookingData) {
  const bookings = getBookings();
  const b = {
    id:        Date.now().toString(),
    ...bookingData,
    status:    'active',
    createdAt: new Date().toISOString(),
  };
  bookings.push(b);
  saveBookings(bookings);
  return b;
}

// ═══════════════════════════════════════════════
//  ОТПРАВКА СООБЩЕНИЙ
// ═══════════════════════════════════════════════

async function sendMsg(to, text) {
  try {
    await client.sendMessage(to, text);
    appendLog({ event: 'MSG_SENT', to, text: text.slice(0, 80) });
  } catch(e) {
    console.error('sendMsg error:', e.message);
  }
}

async function notifyOwner(text) {
  await sendMsg(CONFIG.ownerNumber, text);
}

// ═══════════════════════════════════════════════
//  GROQ AI — ОБРАБОТКА ДИАЛОГА
// ═══════════════════════════════════════════════

function buildSystemPrompt(clientInfo) {
  const today    = new Date();
  const dayNames = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];
  const todayStr = today.toISOString().slice(0, 10);

  const servicesText = CONFIG.business.services
    .map(s => `- ${s.name}: ${s.price} тг (${s.duration} мин)`).join('\n');
  const mastersText = CONFIG.masters
    .map(m => `- ${m.name}: ${m.specialization}, работает: ${m.days.join(', ')}`).join('\n');

  const repeatHint = clientInfo
    ? `\nЭто ПОВТОРНЫЙ клиент. Имя: ${clientInfo.name || 'неизвестно'}. Любимый мастер: ${clientInfo.favoriteMaster || 'нет'}. Последняя услуга: ${clientInfo.favoriteService || 'нет'}.`
    : '\nЭто НОВЫЙ клиент.';

  return `Ты — умный помощник барбершопа "${CONFIG.business.name}" в Казахстане. 
Отвечай только на русском языке. Будь вежливым, дружелюбным и профессиональным.

СЕГОДНЯ: ${todayStr} (${dayNames[today.getDay()]})
Завтра = ${new Date(Date.now()+86400000).toISOString().slice(0,10)}
Послезавтра = ${new Date(Date.now()+172800000).toISOString().slice(0,10)}
${repeatHint}

ИНФОРМАЦИЯ О БАРБЕРШОПЕ:
Название: ${CONFIG.business.name}
Адрес: ${CONFIG.business.address}
Телефон: ${CONFIG.business.phone}
Часы работы: ${CONFIG.business.hours}

УСЛУГИ:
${servicesText}

МАСТЕРА:
${mastersText}

ТВОЯ ЗАДАЧА — ЗАПИСЬ КЛИЕНТОВ:
Веди естественный диалог и постепенно собери:
1. Имя клиента
2. Номер телефона  
3. Желаемую услугу
4. Предпочитаемого мастера (или предложи подходящего)
5. Дату и время

ПРАВИЛА:
- Когда всё собрано — выведи СТРОГО в конце ответа: ЗАПИСЬ_ГОТОВА|имя|телефон|мастер|услуга|дата|время
- Дату ВСЕГДА пиши в формате ГГГГ-ММ-ДД, время — ЧЧ:ММ
- Если клиент говорит "завтра", "послезавтра", "в пятницу" — переводи в конкретную дату
- Если клиент не знает время — скажи что предложишь свободные слоты
- Если клиент хочет отменить запись — напиши: ОТМЕНА_ЗАПРОСА
- Если клиент оставляет отзыв — напиши: ОТЗЫВ|текст отзыва|оценка(1-5)
- Предлагай дополнительные услуги после записи (например укладку к стрижке)
- Не придумывай свободные слоты — они будут проверены отдельно
- Отвечай кратко — не более 3-4 предложений за раз`;
}

async function askGroq(phone, userMessage, clientInfo) {
  // История переписки
  if (!conversations.has(phone)) conversations.set(phone, []);
  const history = conversations.get(phone);

  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  const messages = [
    { role: 'system', content: buildSystemPrompt(clientInfo) },
    ...history,
  ];

  try {
    const res = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      messages,
      max_tokens:  600,
      temperature: 0.7,
    });
    const reply = res.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch(e) {
    console.error('Groq error:', e.message);
    return 'Извините, произошла ошибка. Попробуйте чуть позже.';
  }
}

// ═══════════════════════════════════════════════
//  ПАРСИНГ СПЕЦИАЛЬНЫХ МЕТОК ОТ ИИ
// ═══════════════════════════════════════════════

async function processAIReply(phone, rawReply) {
  // ЗАПИСЬ_ГОТОВА
  const bookingMatch = rawReply.match(/ЗАПИСЬ_ГОТОВА\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^\s|]+)/);
  if (bookingMatch) {
    const [, name, tel, master, service, date, time] = bookingMatch;

    if (isSlotBusy(master.trim(), date.trim(), time.trim())) {
      return rawReply.replace(/ЗАПИСЬ_ГОТОВА\|.+/, '')
        + '\n\n⚠️ К сожалению, этот слот только что заняли. Выберите другое время.';
    }

    const booking = createBooking({
      clientPhone: phone,
      name: name.trim(), phone: tel.trim(),
      master: master.trim(), service: service.trim(),
      date: date.trim(), time: time.trim(),
    });

    // Обновить клиента
    upsertClient(phone, {
      name: name.trim(),
      favoriteMaster:  master.trim(),
      favoriteService: service.trim(),
      lastVisit: date.trim(),
    });
    const cl = getClient(phone);
    const visits = cl.visits || [];
    visits.push({ date: date.trim(), service: service.trim(), master: master.trim(), bookingId: booking.id });
    upsertClient(phone, { visits });

    // Уведомить владельца
    await notifyOwner(
      `🆕 *Новая запись!*\n` +
      `👤 ${name.trim()} (${tel.trim()})\n` +
      `✂️ Услуга: ${service.trim()}\n` +
      `💈 Мастер: ${master.trim()}\n` +
      `📅 ${dateLabel(date.trim())} в ${time.trim()}`
    );

    appendLog({ event: 'BOOKING_CREATED', booking });

    const cleanReply = rawReply.replace(/ЗАПИСЬ_ГОТОВА\|.+/, '').trim();
    return cleanReply || `✅ Отлично! Записал вас:\n*${service.trim()}* к мастеру *${master.trim()}* на *${dateLabel(date.trim())} в ${time.trim()}*\n\nДо встречи! 💈`;
  }

  // ОТМЕНА
  if (rawReply.includes('ОТМЕНА_ЗАПРОСА')) {
    const bookings = getBookings();
    const idx = bookings.findLastIndex(b => b.clientPhone === phone && b.status === 'active');
    if (idx === -1) {
      return 'У вас нет активных записей для отмены.';
    }
    const b = bookings[idx];
    bookings[idx].status    = 'cancelled';
    bookings[idx].cancelledAt = new Date().toISOString();
    saveBookings(bookings);
    await notifyOwner(`❌ *${b.name}* отменил запись на *${b.date} ${b.time}* — ${b.service}`);
    appendLog({ event: 'BOOKING_CANCELLED', bookingId: b.id });
    return `Ваша запись на ${dateLabel(b.date)} в ${b.time} (${b.service}) отменена. Будем ждать вас снова! 🙏`;
  }

  // ОТЗЫВ
  const reviewMatch = rawReply.match(/ОТЗЫВ\|(.+?)\|(\d)/);
  if (reviewMatch) {
    const [, text, rating] = reviewMatch;
    const cl = getClient(phone);
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'), []);
    reviews.push({
      phone, name: cl?.name || phone,
      text: text.trim(), rating: parseInt(rating),
      date: new Date().toISOString(),
    });
    writeJSON(path.join(DATA_DIR, 'reviews.json'), reviews);
    await notifyOwner(`⭐ *Отзыв от ${cl?.name || phone}* (${rating}/5):\n${text.trim()}`);
    if (parseInt(rating) <= 2) {
      await notifyOwner(`🚨 *Плохой отзыв!* Клиент ${cl?.name || phone} поставил ${rating}/5. Рекомендуем связаться.`);
    }
    appendLog({ event: 'REVIEW', phone, rating });
    const cleanReply = rawReply.replace(/ОТЗЫВ\|.+/, '').trim();
    return cleanReply || 'Спасибо за ваш отзыв! Мы ценим каждое мнение 🙏';
  }

  return rawReply;
}

// ═══════════════════════════════════════════════
//  КОМАНДЫ ВЛАДЕЛЬЦА
// ═══════════════════════════════════════════════

async function handleOwnerCommand(msg) {
  const text = msg.body.trim();
  const cmd  = text.split(' ')[0].toLowerCase();
  const arg  = text.slice(cmd.length).trim();

  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  if (cmd === '!записи') {
    const active = getBookings().filter(b => b.status === 'active');
    if (!active.length) return sendMsg(CONFIG.ownerNumber, 'Нет активных записей.');
    const lines = active.map(b => `📅 ${b.date} ${b.time} — ${b.name} | ${b.service} | ${b.master}`);
    return sendMsg(CONFIG.ownerNumber, '*Все активные записи:*\n' + lines.join('\n'));
  }

  if (cmd === '!сегодня') {
    const list = getBookingsForDate(today);
    if (!list.length) return sendMsg(CONFIG.ownerNumber, 'На сегодня записей нет.');
    const lines = list.sort((a,b) => a.time.localeCompare(b.time))
      .map(b => `🕐 ${b.time} — ${b.name} | ${b.service} | ${b.master}`);
    return sendMsg(CONFIG.ownerNumber, `*Сегодня (${today}):*\n` + lines.join('\n'));
  }

  if (cmd === '!завтра') {
    const list = getBookingsForDate(tomorrow);
    if (!list.length) return sendMsg(CONFIG.ownerNumber, 'На завтра записей нет.');
    const lines = list.sort((a,b) => a.time.localeCompare(b.time))
      .map(b => `🕐 ${b.time} — ${b.name} | ${b.service} | ${b.master}`);
    return sendMsg(CONFIG.ownerNumber, `*Завтра (${tomorrow}):*\n` + lines.join('\n'));
  }

  if (cmd === '!статистика') {
    const all     = getBookings();
    const active  = all.filter(b => b.status === 'active').length;
    const month   = all.filter(b => b.date.startsWith(today.slice(0,7)) && b.status !== 'cancelled').length;
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'), []);
    const masterStats = {};
    CONFIG.masters.forEach(m => { masterStats[m.name] = 0; });
    all.filter(b => b.status !== 'cancelled').forEach(b => {
      if (masterStats[b.master] !== undefined) masterStats[b.master]++;
    });
    const mLines = Object.entries(masterStats).map(([n,c]) => `  ${n}: ${c} записей`).join('\n');
    return sendMsg(CONFIG.ownerNumber,
      `*📊 Статистика*\nВсего активных: ${active}\nВ этом месяце: ${month}\nОтзывов: ${reviews.length}\n\nПо мастерам:\n${mLines}`);
  }

  if (cmd === '!выручка') {
    const month = new Date().toISOString().slice(0,7);
    const monthBookings = getBookings().filter(b => b.date.startsWith(month) && b.status !== 'cancelled');
    let total = 0;
    monthBookings.forEach(b => {
      const s = CONFIG.business.services.find(x => x.name === b.service);
      if (s) total += s.price;
    });
    return sendMsg(CONFIG.ownerNumber, `💰 Примерная выручка за месяц: *${total.toLocaleString()} тг*\n(${monthBookings.length} записей)`);
  }

  if (cmd === '!загрузка') {
    const todaySlots = generateSlots(CONFIG.masters[0].name, today).length;
    const lines = CONFIG.masters.map(m => {
      const slots = generateSlots(m.name, today).length;
      const busy  = getBookingsForDate(today).filter(b => b.master === m.name).length;
      const pct   = slots ? Math.round((busy / slots) * 100) : 0;
      return `${m.name}: ${pct}% (${busy}/${slots})`;
    });
    return sendMsg(CONFIG.ownerNumber, `*📈 Загрузка мастеров сегодня:*\n` + lines.join('\n'));
  }

  if (cmd === '!отзывы') {
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'), []);
    const last10  = reviews.slice(-10).reverse();
    if (!last10.length) return sendMsg(CONFIG.ownerNumber, 'Отзывов пока нет.');
    const lines = last10.map(r => `⭐${r.rating} ${r.name}: ${r.text.slice(0,80)}`);
    return sendMsg(CONFIG.ownerNumber, '*Последние отзывы:*\n' + lines.join('\n'));
  }

  if (cmd === '!мастера') {
    const lines = CONFIG.masters.map(m => {
      const total = getBookings().filter(b => b.master === m.name && b.status !== 'cancelled').length;
      return `💈 *${m.name}* — ${m.specialization}\n  Всего записей: ${total}`;
    });
    return sendMsg(CONFIG.ownerNumber, lines.join('\n\n'));
  }

  if (cmd === '!клиент' && arg) {
    const phone   = arg.replace(/\D/g, '') + '@c.us';
    const cl      = getClient(phone);
    if (!cl) return sendMsg(CONFIG.ownerNumber, `Клиент ${arg} не найден.`);
    const visits  = (cl.visits || []).slice(-5).map(v => `  ${v.date} — ${v.service} (${v.master})`).join('\n');
    return sendMsg(CONFIG.ownerNumber,
      `*👤 Клиент ${cl.name || arg}*\nТелефон: ${arg}\nЛюбимый мастер: ${cl.favoriteMaster || '—'}\nЛюбимая услуга: ${cl.favoriteService || '—'}\n\nПоследние визиты:\n${visits || '—'}`);
  }

  if (cmd === '!стоп') {
    botEnabled = false;
    return sendMsg(CONFIG.ownerNumber, '⏸ Бот остановлен. Команда !старт для включения.');
  }

  if (cmd === '!старт') {
    botEnabled = true;
    return sendMsg(CONFIG.ownerNumber, '▶️ Бот запущен!');
  }

  if (cmd === '!статус') {
    const uptime  = process.uptime();
    const hours   = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const clients = Object.keys(getClients()).length;
    const todayN  = getBookingsForDate(today).length;
    return sendMsg(CONFIG.ownerNumber,
      `*🤖 Статус бота*\nРаботает: ${botEnabled ? '✅' : '❌'}\nUptime: ${hours}ч ${minutes}мин\nКлиентов: ${clients}\nЗаписей сегодня: ${todayN}`);
  }

  if (cmd === '!забанить' && arg) {
    const banPhone = arg.replace(/\D/g, '') + '@c.us';
    const banned   = getBanned();
    if (!banned.includes(banPhone)) {
      banned.push(banPhone);
      saveBanned(banned);
    }
    return sendMsg(CONFIG.ownerNumber, `🚫 ${arg} добавлен в чёрный список.`);
  }

  if (cmd === '!очистить') {
    return sendMsg(CONFIG.ownerNumber,
      'Вы уверены? Напишите "ПОДТВЕРЖДАЮ ОЧИСТКУ" для удаления всех записей.');
  }

  if (text === 'ПОДТВЕРЖДАЮ ОЧИСТКУ') {
    saveBookings([]);
    return sendMsg(CONFIG.ownerNumber, '🗑 База записей очищена.');
  }
}

// ═══════════════════════════════════════════════
//  ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ═══════════════════════════════════════════════

client.on('message', async msg => {
  if (msg.isGroupMsg) return;

  const phone = msg.from;
  const text  = msg.body?.trim();
  if (!text) return;

  appendLog({ event: 'MSG_IN', from: phone, text: text.slice(0, 100) });

  // Владелец — команды
  if (phone === CONFIG.ownerNumber) {
    if (text.startsWith('!') || text === 'ПОДТВЕРЖДАЮ ОЧИСТКУ') {
      await handleOwnerCommand(msg);
      return;
    }
  }

  // Чёрный список
  const banned = getBanned();
  if (banned.includes(phone)) return;

  // Антиспам: не чаще раз в 3 секунды
  const lastTime = spamMap.get(phone) || 0;
  if (Date.now() - lastTime < 3000) return;
  spamMap.set(phone, Date.now());

  // Бот выключен
  if (!botEnabled) {
    await sendMsg(phone, `Бот временно недоступен. Звоните: ${CONFIG.business.phone}`);
    return;
  }

  // Получить/создать профиль клиента
  let clientInfo = getClient(phone);

  // Приветствие повторного клиента
  if (clientInfo && !conversations.has(phone)) {
    const daysSinceLast = clientInfo.lastVisit
      ? Math.floor((Date.now() - new Date(clientInfo.lastVisit).getTime()) / 86400000)
      : 0;
    if (daysSinceLast >= 30) {
      await sendMsg(phone,
        `Привет, ${clientInfo.name}! 👋 Скучаем по вам! Уже ${daysSinceLast} дней не видели. Хотите записаться? 💈`);
    }
  }

  // Запрос свободных слотов (если клиент/ИИ просит)
  let slotsHint = '';
  if (/не знаю|любое|свободн|когда|предложи/i.test(text)) {
    const slots = getTop3FreeSlots();
    if (slots.length) {
      slotsHint = '\n\n[Ближайшие свободные слоты:\n' +
        slots.map((s,i) => `${i+1}. ${dateLabel(s.date)} в ${s.time} — мастер ${s.master}`).join('\n') + ']';
    }
  }

  // Запросить ИИ
  const aiRaw   = await askGroq(phone, text + slotsHint, clientInfo);
  const aiReply = await processAIReply(phone, aiRaw);

  await sendMsg(phone, aiReply);
});

// ═══════════════════════════════════════════════
//  ПЛАНИРОВЩИК (напоминания, сводка, ДР)
// ═══════════════════════════════════════════════

function scheduleJobs() {
  // Проверка каждую минуту
  setInterval(async () => {
    const now     = new Date();
    const today   = now.toISOString().slice(0, 10);
    const hh      = now.getHours();
    const mm      = now.getMinutes();
    const bookings = getBookings();

    // Ежедневная сводка в 9:00
    if (hh === 9 && mm === 0) {
      const list = getBookingsForDate(today);
      if (list.length) {
        const lines = list.sort((a,b) => a.time.localeCompare(b.time))
          .map(b => `🕐 ${b.time} — ${b.name} | ${b.service} | ${b.master}`);
        await notifyOwner(`*☀️ Доброе утро! Сводка на сегодня (${today}):*\n` + lines.join('\n'));
      } else {
        await notifyOwner(`☀️ Доброе утро! На сегодня записей нет.`);
      }
    }

    for (const b of bookings) {
      if (b.status !== 'active') continue;
      const visitDt  = new Date(`${b.date}T${b.time}:00`);
      const diffMs   = visitDt - now;
      const diffMin  = Math.round(diffMs / 60000);

      // Напоминание за 24 часа
      if (diffMin >= 1439 && diffMin <= 1441 && !b.reminded24h) {
        await sendMsg(b.clientPhone,
          `⏰ Напоминаем! Завтра в ${b.time} вас ждёт мастер *${b.master}* на услугу *${b.service}*.\n📍 ${CONFIG.business.address}`);
        b.reminded24h = true;
      }

      // Напоминание за 1 час
      if (diffMin >= 59 && diffMin <= 61 && !b.reminded1h) {
        await sendMsg(b.clientPhone,
          `⏰ Через час! Сегодня в ${b.time} — мастер *${b.master}*, *${b.service}*.\nЖдём вас! 💈`);
        b.reminded1h = true;
      }

      // Запрос отзыва через 2 ч после визита
      if (diffMin <= -120 && diffMin >= -122 && !b.reviewRequested) {
        await sendMsg(b.clientPhone,
          `Надеемся, визит прошёл отлично! 🙏 Как вам всё понравилось? Оставьте, пожалуйста, отзыв (оценка от 1 до 5 и пару слов).`);
        b.reviewRequested = true;
      }
    }

    saveBookings(bookings);

    // Дни рождения
    if (hh === 10 && mm === 0) {
      const clients = getClients();
      const todayMD = today.slice(5);
      for (const [phone, cl] of Object.entries(clients)) {
        if (cl.birthday && cl.birthday.slice(5) === todayMD) {
          await sendMsg(phone,
            `🎉 С Днём Рождения, ${cl.name}! Дарим вам скидку 10% на любую услугу сегодня! Просто скажите при записи. 🎁`);
        }
      }
    }

  }, 60000); // каждую минуту

  // Проверка пропущенных визитов каждый день в 23:00
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 23 || now.getMinutes() !== 0) return;
    const clients = getClients();
    for (const [phone, cl] of Object.entries(clients)) {
      if (!cl.lastVisit) continue;
      const noShows = (cl.noShows || 0);
      if (noShows >= 3) {
        await notifyOwner(`⚠️ Клиент *${cl.name || phone}* уже 3 раза не пришёл на запись!`);
      }
    }
  }, 60000);
}

// ═══════════════════════════════════════════════
//  ЗАПУСК
// ═══════════════════════════════════════════════

console.log('🚀 Запуск WhatsApp бота...');
console.log(`📌 Откройте QR-страницу: http://localhost:${CONFIG.webPort}`);
client.initialize();
