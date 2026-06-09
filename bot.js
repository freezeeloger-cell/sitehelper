require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 300_000 });

// ─── PERSISTENT MEMORY (диск, переживает перезапуски) ────────────────────────
const MEMORY_FILE = process.env.MEMORY_FILE || '/data/memory.json';
let memory = { sessions: {}, log: [] };

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      memory.sessions = parsed.sessions || {};
      memory.log = parsed.log || [];
      console.log(`🧠 Память загружена: сессий ${Object.keys(memory.sessions).length}, статей в журнале ${memory.log.length}`);
    } else {
      console.log('🧠 Файл памяти не найден — начинаю с чистого листа.');
    }
  } catch (e) {
    console.error('🧠 Ошибка загрузки памяти:', e.message);
  }
}

let saveTimer = null;
function saveMemory() {
  // Лёгкий дебаунс, чтобы не писать на диск слишком часто
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory));
    } catch (e) {
      console.error('🧠 Ошибка сохранения памяти:', e.message);
    }
  }, 400);
}

// Записать опубликованную статью в журнал (чтобы помнить и не дублировать темы)
function logPublished(article) {
  memory.log.unshift({
    title: article.h1,
    slug: article.slug,
    category: article.category || null,
    keywords: article.keywords || [],
    publishedAt: new Date().toISOString(),
  });
  if (memory.log.length > 500) memory.log.length = 500; // не растём бесконечно
  saveMemory();
}

// ─── SESSION (на диске) ──────────────────────────────────────────────────────
function getSession(chatId) {
  if (!memory.sessions[chatId]) { memory.sessions[chatId] = { state: 'idle', photos: [], info: {} }; saveMemory(); }
  return memory.sessions[chatId];
}
function resetSession(chatId) {
  memory.sessions[chatId] = { state: 'idle', photos: [], info: {} };
  saveMemory();
}

// Запоминаем владельца (для авто-сообщений по расписанию)
bot.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type === 'private' && memory.ownerChatId !== ctx.chat.id) {
    memory.ownerChatId = ctx.chat.id;
    saveMemory();
  }
  return next();
});

// ─── PAYLOAD CMS ─────────────────────────────────────────────────────────────
const CMS_URL    = process.env.PAYLOAD_URL    || 'https://crabnorway.com';
const CMS_EMAIL  = process.env.PAYLOAD_EMAIL;
const CMS_PASS   = process.env.PAYLOAD_PASS;
const COLLECTION = process.env.PAYLOAD_COLLECTION || 'posts';

const SECTIONS = {
  'кейс':    { slug: COLLECTION, category: 'case',    label: 'Кейс' },
  'кейсы':   { slug: COLLECTION, category: 'case',    label: 'Кейс' },
  'блог':    { slug: COLLECTION, category: 'blog',    label: 'Блог' },
  'статья':  { slug: COLLECTION, category: 'blog',    label: 'Блог' },
  'faq':     { slug: COLLECTION, category: 'faq',     label: 'FAQ' },
  'вопрос':  { slug: COLLECTION, category: 'faq',     label: 'FAQ' },
  'новость': { slug: COLLECTION, category: 'news',    label: 'Новость' },
};

async function payloadLogin() {
  const res = await fetch(`${CMS_URL}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CMS_EMAIL, password: CMS_PASS }),
  });
  if (!res.ok) throw new Error(`Payload login failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function uploadPhotoToPayload(token, photoBuffer, filename, alt) {
  const form = new FormData();
  form.append('file', photoBuffer, { filename, contentType: 'image/jpeg' });
  // Payload reads non-file fields from a JSON string in `_payload` (alt is usually required on Media)
  form.append('_payload', JSON.stringify({ alt: alt || 'CrabNorway' }));
  const res = await fetch(`${CMS_URL}/api/media`, {
    method: 'POST',
    headers: { Authorization: `JWT ${token}`, ...form.getHeaders() },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields = (data?.errors?.[0]?.data?.errors || []).map(e => e.field).join(', ');
    const msg = data?.errors?.[0]?.message || `Media upload failed: ${res.status}`;
    throw new Error(fields ? `${msg} (поля Media: ${fields})` : msg);
  }
  return data?.doc?.id || data?.id || null;
}

const CATEGORY_ID = process.env.PAYLOAD_CATEGORY_ID || 4;
const AUTHOR_ID   = process.env.PAYLOAD_AUTHOR_ID   || 1;

async function createPost(token, article, mediaIds) {
  // Featured Image is required — must have at least one uploaded photo
  if (!mediaIds || mediaIds.length === 0) {
    throw new Error('Нужна обложка: прикрепи хотя бы одно фото к статье и попробуй снова.');
  }

  const body = {
    title:         article.h1,
    slug:          article.slug,
    excerpt:       article.excerpt,
    content:       toPayloadLexical(article.blocks),
    category:      CATEGORY_ID,
    author:        AUTHOR_ID,
    featuredImage: mediaIds[0],
    _status:       'published',
    status:        'published',
    publishedAt:   new Date().toISOString(),
    meta: { title: article.metaTitle, description: article.metaDesc },
  };

  const res = await fetch(`${CMS_URL}/api/${COLLECTION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const fields = (data?.errors?.[0]?.data?.errors || []).map(e => e.field).join(', ');
    const msg = data?.errors?.[0]?.message || `Post create failed: ${res.status}`;
    throw new Error(fields ? `${msg} (поля: ${fields})` : msg);
  }
  return data?.doc || data;
}

// ─── PAYLOAD LEXICAL CONVERTER ───────────────────────────────────────────────
function lexText(text, bold) {
  return { type:'text', text, format: bold ? 1 : 0, detail:0, mode:'normal', style:'', version:1 };
}
function lexLink(label, url) {
  return {
    type:'link', version:3, format:'', indent:0, direction:'ltr',
    fields: { linkType:'custom', newTab:true, url },
    children: [ lexText(label, false) ],
  };
}
// Превращает [текст](url) → ссылку, **текст** → жирный, остальное — обычный текст
function parseInline(text) {
  const nodes = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(lexText(text.slice(last, m.index), false));
    if (m[2]) nodes.push(lexLink(m[1], m[2]));      // ссылка
    else if (m[3]) nodes.push(lexText(m[3], true));  // жирный
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(lexText(text.slice(last), false));
  if (nodes.length === 0) nodes.push(lexText(text || '', false));
  return nodes;
}
function stripMarkdown(text) {
  return (text || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1');
}
function toPayloadLexical(blocks) {
  const children = (blocks || []).map(b => {
    if (['h1','h2','h3'].includes(b.type)) {
      return { type:'heading', tag:b.type, version:1, format:'', indent:0, direction:'ltr',
               children:[ lexText(stripMarkdown(b.text), false) ] };
    }
    return { type:'paragraph', version:1, format:'', indent:0, direction:'ltr',
             textFormat:0, textStyle:'',
             children: parseInline(b.text || '') };
  });
  return { root:{ type:'root', version:1, format:'', indent:0, direction:'ltr', children } };
}

// ─── CLAUDE API ───────────────────────────────────────────────────────────────
const MODEL = 'claude-sonnet-4-6';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callClaude(messages, system, useSearch = false, maxTokens = 8000) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  // Up to 4 attempts with backoff on rate-limit (429) / overloaded (529) / transient (5xx)
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          ...(useSearch ? { 'anthropic-beta': 'web-search-2025-03-05' } : {}),
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        // Wait and retry: respect Retry-After if present, else exponential backoff
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 8000;
        lastErr = new Error(`Claude API error: ${res.status}`);
        if (attempt < 4) { await sleep(waitMs); continue; }
        throw lastErr;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Claude API error: ${res.status} ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      return data.content.map(c => c.text || '').join('');
    } catch (e) {
      lastErr = e;
      // Network hiccup — retry a couple times
      if (attempt < 4 && /fetch|network|ECONN|timeout/i.test(e.message)) {
        await sleep(attempt * 4000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Safely extract a JSON object from a model response, tolerating truncation/markdown
function parseArticleJson(raw) {
  let s = raw.replace(/```json|```/g, '').trim();
  // Grab from the first { to the last } in case of stray text
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error('Модель вернула неполный ответ. Попробуй ещё раз — обычно со второго раза проходит.');
  }
}

const AMORE_LINK = process.env.AMORE_LINK || 'https://t.me/Crabnorwaybot/amore';

const SYSTEM = `Ты — Игорь, контент-редактор и SEO-специалист сайта CrabNorway.com. Ты правая рука Даниила Богатько и фактически ведёшь сайт: пишешь статьи, думаешь про продвижение в Google и про то, как читатель перейдёт в сообщество АМОРЕ.

КТО ТАКОЙ ДАНИИЛ (от его лица пишешь): рыбак, 8 норвежских судов, 6+ лет в море — краболовы, траулеры, ярусоловы. Реальный опыт, не теория.
НИША: трудоустройство на норвежские краболовные и рыболовные суда.
АУДИТОРИЯ: русскоязычные 20-40 лет, часто без морского опыта, хотят зарабатывать в Норвегии.

КАК ПИСАТЬ (это важно — пиши как живой человек, не как ИИ):
- От первого лица, как Даниил: «я работал», «на моём первом судне», конкретные цифры и случаи.
- Живой разговорный язык, короткие абзацы. Никаких штампов: НЕ писать «в современном мире», «в этой статье мы рассмотрим», «важно отметить», «в заключение хочется сказать».
- Конкретика вместо воды: суммы в евро, названия документов (BST, медкомиссия, паспорт моряка), сроки, реальные ситуации.
- Думай про SEO: ключевые слова естественно в заголовках и тексте.

ВОРОНКА В АМОРЕ (обязательно в каждой статье):
В конце статьи плавно, по-человечески подведи читателя к сообществу АМОРЕ — это закрытое сообщество моряков с менторами, где помогают устроиться на норвежские суда. Не «купи курс», а по-дружески: мол, если хочешь пройти этот путь не в одиночку, а с теми, кто уже там — вот куда заглянуть. И обязательно вставь ссылку в формате [АМОРЕ](${AMORE_LINK}).

ССЫЛКИ: где уместно, добавляй ссылки в Markdown [текст](url). Внутренние: https://crabnorway.com, https://crabnorway.com/blog. Не выдумывай несуществующие адреса статей.`;

// ─── SLUGIFY ──────────────────────────────────────────────────────────────────
function slugify(str) {
  const map = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
  return str.toLowerCase().replace(/[а-яё]/g, c => map[c] || c).replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

// ─── DETECT SECTION ───────────────────────────────────────────────────────────
function detectSection(text) {
  const lower = text.toLowerCase();
  for (const [key, val] of Object.entries(SECTIONS)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

// ─── CLARIFY QUESTIONS ────────────────────────────────────────────────────────
async function getClarifyingQuestions(userText, section) {
  const prompt = `Даниил дал задачу для написания статьи на CrabNorway.com.
Раздел: ${section?.label || 'не указан'}
Задача: "${userText}"

Задай 2-3 уточняющих вопроса если тебе НЕ хватает конкретики для написания качественной статьи.
Спрашивай только самое важное. Если задача уже достаточно конкретная — верни пустую строку.
Вопросы короткие, по делу, на русском. Без приветствий. Только вопросы, каждый с новой строки.`;
  const resp = await callClaude([{ role:'user', content:prompt }], SYSTEM, false, 500);
  return resp.trim();
}

// ─── WRITE ARTICLE ────────────────────────────────────────────────────────────
async function writeArticle(session) {
  const { info } = session;
  const context = [
    `Раздел: ${info.section?.label || 'Блог'}`,
    `Задача: ${info.brief}`,
    info.answers ? `Уточнения от Даниила: ${info.answers}` : '',
    info.photos?.length ? `Фото: ${info.photos.length} штук прикреплено` : '',
  ].filter(Boolean).join('\n');

  // Research
  const research = await callClaude(
    [{ role:'user', content:`Найди актуальные факты для статьи CrabNorway.com. Контекст:\n${context}\nКонспект фактов, до 300 слов.` }],
    SYSTEM, true, 1500
  );

  // Write
  const articleRaw = await callClaude([{
    role: 'user',
    content: `Напиши статью для CrabNorway.com.
${context}
Исследование: ${research}

ВЕРНИ ТОЛЬКО ВАЛИДНЫЙ JSON (без markdown-блоков):
{
  "h1": "заголовок до 70 символов с ключевым словом",
  "metaTitle": "SEO заголовок до 60 символов",
  "metaDesc": "мета-описание 150-160 символов с призывом",
  "slug": "url-slug-latinitsey",
  "excerpt": "анонс 2 предложения",
  "keywords": ["ключ1","ключ2","ключ3","ключ4","ключ5"],
  "blocks": [
    {"type":"h2","text":"..."},
    {"type":"p","text":"..."}
  ]
}
Минимум 12 блоков. Стиль Даниила — личный опыт, цифры, без воды.
ОБЯЗАТЕЛЬНО: последние 1-2 блока — живой подвод к сообществу АМОРЕ со ссылкой [АМОРЕ](${AMORE_LINK}).`
  }], SYSTEM);

  const article = parseArticleJson(articleRaw);
  article.category = info.section?.category || 'blog';
  if (!article.slug) article.slug = slugify(article.h1);

  // Страховка: если модель не вставила ссылку на АМОРЕ — добавляем блок сами
  const hasAmore = JSON.stringify(article.blocks || []).includes('Crabnorwaybot/amore');
  if (!hasAmore) {
    article.blocks = article.blocks || [];
    article.blocks.push({
      type: 'p',
      text: `Хочешь пройти этот путь не в одиночку, а с теми, кто уже работает на норвежских судах? Загляни в наше сообщество моряков — [АМОРЕ](${AMORE_LINK}). Там менторы помогают с документами, резюме и реальными вакансиями.`,
    });
  }
  return article;
}

// ─── DOWNLOAD PHOTO FROM TELEGRAM ────────────────────────────────────────────
async function downloadTelegramPhoto(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

// ─── FORMAT PREVIEW ──────────────────────────────────────────────────────────
function formatPreview(article) {
  const kw = (article.keywords || []).join(', ');
  return `📄 *СТАТЬЯ ГОТОВА* — предпросмотр

*${article.h1}*

🏷 *Meta Title:* ${article.metaTitle}
📝 *Meta Desc:* ${article.metaDesc}
🔗 *Slug:* \`/${article.slug}\`
🔑 *Ключи:* ${kw}

📖 *Анонс:*
${article.excerpt}

─────────────────
Всего блоков: ${article.blocks?.length || 0}
Раздел: ${article.category}

Публикую? 👇`;
}

// Build the full readable article text from blocks
function renderFullText(article) {
  let out = `📰 ${article.h1}\n\n`;
  for (const b of (article.blocks || [])) {
    const text = (b.text || '').replace(/\*\*(.+?)\*\*/g, '$1');
    if (b.type === 'h2') out += `\n━━━ ${text} ━━━\n`;
    else if (b.type === 'h3') out += `\n▸ ${text}\n`;
    else out += `${text}\n`;
  }
  return out.trim();
}

// Telegram caps messages at ~4096 chars — split safely on paragraph breaks
function splitMessage(text, limit = 3800) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > limit) {
      if (current) parts.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ─── BOT HANDLERS ────────────────────────────────────────────────────────────

bot.start(ctx => {
  resetSession(ctx.chat.id);
  ctx.reply(`👋 Привет, Даниил!

Я твоя правая рука по контенту для CrabNorway.com.

*Как работать:*
1. Напиши задачу — что за статья, о чём, в какой раздел
2. Прикрепи фото если есть (можно несколько)
3. Я уточню если чего-то не хватает
4. Напишу статью и опубликую на сайт

*Разделы:* кейс / блог / статья / faq / новость

*Команды:*
/gaps — идеи статей по конкурентам
/log — что уже опубликовано

Давай задачу 👇`, { parse_mode: 'Markdown' });
});

bot.command('reset', ctx => {
  resetSession(ctx.chat.id);
  ctx.reply('🔄 Сброшено. Давай новую задачу.');
});

bot.command('status', ctx => {
  const s = getSession(ctx.chat.id);
  ctx.reply(`Статус: *${s.state}*\nФото: ${s.photos.length}\nРаздел: ${s.info.section?.label || 'не задан'}`, { parse_mode:'Markdown' });
});

bot.command('log', ctx => {
  if (!memory.log.length) return ctx.reply('📚 Журнал пуст — ещё ничего не публиковал.');
  const last = memory.log.slice(0, 15)
    .map((a, i) => `${i + 1}. ${a.title}\n   /blog/${a.slug}`)
    .join('\n');
  ctx.reply(`📚 *Последние статьи (всего ${memory.log.length}):*\n\n${last}`, { parse_mode:'Markdown' });
});

bot.command('gaps', ctx => runGapAnalysis(ctx.chat.id));

// ─── PHOTO HANDLER ───────────────────────────────────────────────────────────
bot.on('photo', async ctx => {
  const session = getSession(ctx.chat.id);
  const photo = ctx.message.photo;
  const best = photo[photo.length - 1]; // highest res
  session.photos.push(best.file_id);

  const caption = ctx.message.caption;
  if (session.state === 'awaiting_confirm') {
    // Photo added as cover for a ready article
    return ctx.reply(`📸 Обложка добавлена. Теперь жми «✅ Публикуй».`,
      Markup.keyboard([['✅ Публикуй', '✏️ Переделай'], ['❌ Отмена']]).oneTime().resize());
  } else if (caption) {
    // Photo came with a caption — treat it as a brief
    await handleBrief(ctx, session, caption);
  } else if (session.state === 'idle') {
    ctx.reply(`📸 Фото получено (${session.photos.length} шт.).\n\nТеперь напиши задачу: что писать, в какой раздел и о чём/о ком.`);
    session.state = 'waiting_brief';
  } else {
    ctx.reply(`📸 Фото добавлено (всего ${session.photos.length}). Продолжай.`);
  }
});

// ─── TEXT HANDLER (единый конечный автомат) ──────────────────────────────────
const SECTION_BUTTONS = { 'Кейс': 'кейс', 'Блог': 'блог', 'FAQ': 'faq', 'Новость': 'новость' };

bot.on('text', async ctx => {
  const session = getSession(ctx.chat.id);
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  // ── Отмена работает в любом состоянии ──
  if (text === '❌ Отмена' || text === 'Отмена') {
    resetSession(ctx.chat.id);
    return ctx.reply('Отменено. Давай новую задачу.', Markup.removeKeyboard());
  }

  // ── Ждём подтверждения публикации ──
  if (session.state === 'awaiting_confirm') {
    if (text === '✅ Публикуй') {
      return publishArticle(ctx, session);
    }
    if (text === '✏️ Переделай') {
      session.state = 'redoing';
      return ctx.reply('Что переделать? Напиши правки одним сообщением.', Markup.removeKeyboard());
    }
    // Любой другой текст = дополнительные правки → переписываем
    session.info.answers = (session.info.answers || '') + '\nДоп. правки: ' + text;
    return processAndWrite(ctx, session);
  }

  // ── Собираем правки для переделки ──
  if (session.state === 'redoing') {
    session.info.answers = (session.info.answers || '') + '\nПравки: ' + text;
    return processAndWrite(ctx, session);
  }

  // ── Ждём выбор раздела (тему НЕ затираем!) ──
  if (session.state === 'waiting_section') {
    const key = SECTION_BUTTONS[text];
    if (!key) {
      return ctx.reply(
        'Выбери раздел кнопкой ниже 👇',
        Markup.keyboard([['Кейс', 'Блог', 'FAQ'], ['Новость', '❌ Отмена']]).oneTime().resize()
      );
    }
    session.info.section = SECTIONS[key];
    await ctx.reply(`✅ Раздел: ${session.info.section.label}`, Markup.removeKeyboard());
    return askClarifyOrWrite(ctx, session);
  }

  // ── Ответы на уточняющие вопросы ──
  if (session.state === 'clarifying') {
    session.info.answers = (session.info.answers || '') + '\n' + text;
    return processAndWrite(ctx, session);
  }

  // ── По умолчанию — новая задача ──
  await handleBrief(ctx, session, text);
});

// ─── HANDLE BRIEF ────────────────────────────────────────────────────────────
async function handleBrief(ctx, session, text) {
  session.state = 'gathering';
  session.info.brief = text;
  session.info.section = detectSection(text);

  if (!session.info.section) {
    await ctx.reply(
      '📂 В какой раздел публикуем?',
      Markup.keyboard([['Кейс', 'Блог', 'FAQ'], ['Новость', '❌ Отмена']]).oneTime().resize()
    );
    session.state = 'waiting_section';
    return;
  }

  await askClarifyOrWrite(ctx, session);
}

// ─── CLARIFY OR WRITE ────────────────────────────────────────────────────────
async function askClarifyOrWrite(ctx, session) {
  const thinking = await ctx.reply('🤔 Анализирую задачу...');

  try {
    const questions = await getClarifyingQuestions(session.info.brief, session.info.section);

    await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id).catch(() => {});

    if (questions && questions.length > 10) {
      session.state = 'clarifying';
      await ctx.reply(`❓ *Уточни пожалуйста:*\n\n${questions}`, { parse_mode:'Markdown' });
    } else {
      await processAndWrite(ctx, session);
    }
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id).catch(() => {});
    ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

// ─── PROCESS AND WRITE ───────────────────────────────────────────────────────
async function processAndWrite(ctx, session) {
  session.state = 'writing';

  const msg = await ctx.reply('✍️ Исследую тему и пишу статью...\n\nЭто займёт ~30 секунд.');

  try {
    const article = await writeArticle(session);
    session.info.article = article;

    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});

    // Send the full article text first (split into chunks if long)
    await ctx.reply('📖 Полный текст статьи — прочитай перед публикацией:');
    for (const part of splitMessage(renderFullText(article))) {
      await ctx.reply(part);
      await sleep(300); // small gap so messages arrive in order
    }

    session.state = 'awaiting_confirm';
    saveMemory(); // статья готова — сохраняем, чтобы перезапуск не сбил
    if (session.photos.length === 0) {
      await ctx.reply('⚠️ К статье не прикреплено фото, а обложка обязательна. Пришли фото сейчас (одним сообщением), потом жми «Публикуй».');
    }
    await ctx.reply(formatPreview(article), {
      parse_mode: 'Markdown',
      ...Markup.keyboard([['✅ Публикуй', '✏️ Переделай'], ['❌ Отмена']]).oneTime().resize()
    });

  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    session.state = 'idle';
    ctx.reply(`❌ Ошибка написания: ${e.message}\n\nПопробуй переформулировать задачу.`);
  }
}

// ─── PUBLISH ─────────────────────────────────────────────────────────────────
async function publishArticle(ctx, session) {
  session.state = 'publishing';
  const article = session.info.article;
  await ctx.reply('🚀 Публикую на сайт...', Markup.removeKeyboard());

  try {
    const token = await payloadLogin();

    // Upload photos
    const mediaIds = [];
    if (session.photos.length > 0) {
      await ctx.reply('📸 Загружаю фото...').catch(() => {});
      for (let i = 0; i < Math.min(session.photos.length, 3); i++) {
        const buf = await downloadTelegramPhoto(ctx, session.photos[i]);
        const mediaId = await uploadPhotoToPayload(token, buf, `crab-${Date.now()}-${i}.jpg`, article.h1);
        if (mediaId) mediaIds.push(mediaId);
      }
    }

    await ctx.reply('📝 Создаю статью...').catch(() => {});
    const result = await createPost(token, article, mediaIds);

    const url = `${CMS_URL}/blog/${article.slug}`;
    logPublished(article);
    await ctx.reply(
      `✅ *Опубликовано!*\n\n*${article.h1}*\n\n🔗 ${url}\n📸 Фото: ${mediaIds.length} загружено\n\n📚 Всего статей в журнале бота: ${memory.log.length}`,
      { parse_mode:'Markdown' }
    );

    resetSession(ctx.chat.id);

  } catch (e) {
    session.state = 'awaiting_confirm';
    ctx.reply(
      `❌ Ошибка публикации: ${e.message}\n\nСтатья сохранена — нажми «Публикуй», чтобы попробовать снова.`,
      Markup.keyboard([['✅ Публикуй', '❌ Отмена']]).oneTime().resize()
    );
  }
}

// ─── КОНКУРЕНТЫ ──────────────────────────────────────────────────────────────
const COMPETITORS = (process.env.COMPETITORS || 'https://alexfisherway.com,https://bfisherman.com')
  .split(',').map(s => s.trim()).filter(Boolean);

async function fetchWithTimeout(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 CrabBot' } });
  } finally {
    clearTimeout(t);
  }
}

// Собирает темы конкурента: из sitemap.xml, иначе из заголовков главной
async function fetchCompetitorTopics(baseUrl) {
  const topics = [];
  const root = baseUrl.replace(/\/+$/, '');
  try {
    const r = await fetchWithTimeout(`${root}/sitemap.xml`);
    if (r.ok) {
      const xml = await r.text();
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
      for (const u of locs) {
        if (/\.(xml|jpg|png|webp|css|js)/i.test(u)) continue;
        const slug = u.split('/').filter(Boolean).pop();
        if (slug && slug.length > 3 && !slug.includes('.') && !/^https?$/.test(slug)) topics.push(slug.replace(/[-_]+/g, ' '));
      }
    }
  } catch (e) { /* ignore */ }
  if (topics.length < 3) {
    try {
      const r = await fetchWithTimeout(root);
      if (r.ok) {
        const html = await r.text();
        const titles = [...html.matchAll(/<(?:h1|h2|h3|title)[^>]*>([^<]{8,140})<\/(?:h1|h2|h3|title)>/gi)]
          .map(m => m[1].replace(/\s+/g, ' ').trim());
        topics.push(...titles);
      }
    } catch (e) { /* ignore */ }
  }
  return [...new Set(topics)].slice(0, 40);
}

async function runGapAnalysis(targetChatId) {
  await bot.telegram.sendMessage(targetChatId, '🥊 Смотрю конкурентов, собираю идеи...').catch(() => {});
  let comp = '';
  for (const url of COMPETITORS) {
    const t = await fetchCompetitorTopics(url);
    comp += `\n[${url}] (${t.length} тем):\n${t.join('\n') || '— не удалось прочитать'}\n`;
  }
  const myTopics = memory.log.map(a => a.title).join('\n') || '(пока статей нет)';
  const prompt = `Ты SEO-стратег CrabNorway.com (работа на краболовных и рыболовных судах в Норвегии).

ТЕМЫ КОНКУРЕНТОВ:${comp}

ТЕМЫ, КОТОРЫЕ УЖЕ ЕСТЬ У НАС:
${myTopics}

Найди 4-5 тем, которые есть/намекаются у конкурентов или логично нужны в нише, но которых у НАС ещё нет. Для каждой: цепляющий заголовок + одна строка почему стоит написать (польза для SEO/аудитории). Кратко, по-русски, без вступлений и воды. Пронумеруй.`;
  try {
    const ideas = await callClaude([{ role: 'user', content: prompt }], SYSTEM, false, 1500);
    await bot.telegram.sendMessage(
      targetChatId,
      `💡 *Идеи статей — чего у тебя нет (по конкурентам):*\n\n${ideas}\n\n👉 Понравилась тема? Просто дай мне её обычным способом — напишу и опубликуем.`,
      { parse_mode: 'Markdown' }
    ).catch(() => bot.telegram.sendMessage(targetChatId, `💡 Идеи статей:\n\n${ideas}`));
  } catch (e) {
    await bot.telegram.sendMessage(targetChatId, `❌ Не смог собрать идеи: ${e.message}`).catch(() => {});
  }
}

// ─── РАСПИСАНИЕ (без внешних пакетов) ─────────────────────────────────────────
// Раз в неделю: понедельник 10:00 по Болгарии
function checkSchedule() {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Sofia', weekday: 'short', hour: '2-digit',
        hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
    if (parts.weekday === 'Mon' && parts.hour === '10' && memory.lastGapsDate !== dateStr && memory.ownerChatId) {
      memory.lastGapsDate = dateStr;
      saveMemory();
      console.log('⏰ Запускаю еженедельный анализ конкурентов');
      runGapAnalysis(memory.ownerChatId).catch(e => console.error('gaps error:', e.message));
    }
  } catch (e) {
    console.error('schedule error:', e.message);
  }
}

// ─── LAUNCH ──────────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('⚠️ Ошибка обработки:', err?.message || err);
  try { ctx.reply('⚠️ Что-то пошло не так при обработке. Попробуй ещё раз или напиши /start.'); } catch (_) {}
});

loadMemory();
bot.launch()
  .then(() => console.log('✅ CrabNorway Bot запущен'))
  .catch(e => console.error('❌ Ошибка запуска:', e));

setInterval(checkSchedule, 30 * 60 * 1000); // проверка каждые 30 минут
checkSchedule();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
