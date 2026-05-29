require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ─── SESSION (in-memory, можно заменить на Redis) ────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { state: 'idle', photos: [], info: {} };
  return sessions[chatId];
}
function resetSession(chatId) {
  sessions[chatId] = { state: 'idle', photos: [], info: {} };
}

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

async function uploadPhotoToPayload(token, photoBuffer, filename) {
  const form = new FormData();
  form.append('file', photoBuffer, { filename, contentType: 'image/jpeg' });
  const res = await fetch(`${CMS_URL}/api/media`, {
    method: 'POST',
    headers: { Authorization: `JWT ${token}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.doc?.id || data?.id || null;
}

async function createPost(token, article, mediaIds) {
  const body = {
    title:    article.h1,
    slug:     article.slug,
    excerpt:  article.excerpt,
    content:  toPayloadLexical(article.blocks),
    _status:  'published',
    meta: { title: article.metaTitle, description: article.metaDesc },
  };
  if (article.category) body.category = article.category;
  if (mediaIds && mediaIds.length > 0) body.heroImage = mediaIds[0];
  const res = await fetch(`${CMS_URL}/api/${COLLECTION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.errors?.[0]?.message || `Post create failed: ${res.status}`);
  return data?.doc || data;
}

// ─── PAYLOAD LEXICAL CONVERTER ───────────────────────────────────────────────
function toPayloadLexical(blocks) {
  const children = (blocks || []).map(b => {
    if (['h1','h2','h3'].includes(b.type)) {
      return { type:'heading', tag:b.type, version:1, format:'', indent:0, direction:'ltr',
               children:[{ type:'text', text:b.text, format:0, version:1 }] };
    }
    return { type:'paragraph', version:1, format:'', indent:0, direction:'ltr',
             textFormat:0, textStyle:'',
             children:[{ type:'text', text:b.text, format:0, version:1 }] };
  });
  return { root:{ type:'root', version:1, format:'', indent:0, direction:'ltr', children } };
}

// ─── CLAUDE API ───────────────────────────────────────────────────────────────
async function callClaude(messages, system, useSearch = false) {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system,
    messages,
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
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
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content.map(c => c.text || '').join('');
}

const SYSTEM = `Ты — контент-агент Даниила Богатько для сайта CrabNorway.com.
Ниша: трудоустройство на норвежские краболовные/рыболовные суда.
Аудитория: русскоязычные 20-40 лет, часто без морского опыта.
Автор Даниил — 8 судов, 6+ лет в норвежском флоте. Стиль: личный, от первого лица, конкретика и цифры, без воды.
Разделы сайта: Кейсы (истории реальных людей), Блог (советы/гайды), FAQ, Новости.`;

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
  const resp = await callClaude([{ role:'user', content:prompt }], SYSTEM);
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
    SYSTEM, true
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
Минимум 12 блоков. Стиль Даниила — личный опыт, цифры, без воды.`
  }], SYSTEM);

  const clean = articleRaw.replace(/```json|```/g,'').trim();
  const article = JSON.parse(clean);
  article.category = info.section?.category || 'blog';
  if (!article.slug) article.slug = slugify(article.h1);
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

// ─── PHOTO HANDLER ───────────────────────────────────────────────────────────
bot.on('photo', async ctx => {
  const session = getSession(ctx.chat.id);
  const photo = ctx.message.photo;
  const best = photo[photo.length - 1]; // highest res
  session.photos.push(best.file_id);

  const caption = ctx.message.caption;
  if (caption) {
    // Photo came with a caption — treat it as a brief
    await handleBrief(ctx, session, caption);
  } else if (session.state === 'idle') {
    ctx.reply(`📸 Фото получено (${session.photos.length} шт.).\n\nТеперь напиши задачу: что писать, в какой раздел и о чём/о ком.`);
    session.state = 'waiting_brief';
  } else {
    ctx.reply(`📸 Фото добавлено (всего ${session.photos.length}). Продолжай.`);
  }
});

// ─── TEXT HANDLER ────────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const session = getSession(ctx.chat.id);
  const text = ctx.message.text;

  if (text.startsWith('/')) return;

  // Waiting for answer to clarifying questions
  if (session.state === 'clarifying') {
    session.info.answers = (session.info.answers || '') + '\n' + text;
    await processAndWrite(ctx, session);
    return;
  }

  // Confirm publish
  if (session.state === 'awaiting_confirm') {
    const lower = text.toLowerCase();
    if (['да','yes','ок','ok','давай','публикуй','го','publish'].some(w => lower.includes(w))) {
      await publishArticle(ctx, session);
    } else if (['нет','no','стоп','отмена','cancel','переделай','ещё раз'].some(w => lower.includes(w))) {
      resetSession(ctx.chat.id);
      ctx.reply('Окей, отменено. Давай новую задачу или уточни что переделать.');
    } else {
      // Treat as additional instructions
      session.info.answers = (session.info.answers || '') + '\nДоп. правки: ' + text;
      session.state = 'clarifying';
      await processAndWrite(ctx, session);
    }
    return;
  }

  // Default — treat as new brief
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
      Markup.keyboard([['Кейс', 'Блог', 'FAQ'], ['Новость', 'Отмена']]).oneTime().resize()
    );
    session.state = 'waiting_section';
    return;
  }

  await askClarifyOrWrite(ctx, session);
}

// ─── KEYBOARD CALLBACKS ──────────────────────────────────────────────────────
bot.hears(['Кейс', 'Блог', 'FAQ', 'Новость'], async ctx => {
  const session = getSession(ctx.chat.id);
  const map = { 'Кейс': SECTIONS['кейс'], 'Блог': SECTIONS['блог'], 'FAQ': SECTIONS['faq'], 'Новость': SECTIONS['новость'] };
  session.info.section = map[ctx.message.text];
  await ctx.reply(`✅ Раздел: *${session.info.section.label}*`, { parse_mode:'Markdown', ...Markup.removeKeyboard() });
  await askClarifyOrWrite(ctx, session);
});

bot.hears('Отмена', ctx => {
  resetSession(ctx.chat.id);
  ctx.reply('Отменено.', Markup.removeKeyboard());
});

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

    session.state = 'awaiting_confirm';
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
bot.hears('✅ Публикуй', async ctx => {
  const session = getSession(ctx.chat.id);
  if (session.state !== 'awaiting_confirm') return;
  await publishArticle(ctx, session);
});

bot.hears('✏️ Переделай', async ctx => {
  const session = getSession(ctx.chat.id);
  session.state = 'clarifying';
  ctx.reply('Что переделать? Напиши правки.', Markup.removeKeyboard());
});

bot.hears('❌ Отмена', ctx => {
  resetSession(ctx.chat.id);
  ctx.reply('Отменено. Давай новую задачу.', Markup.removeKeyboard());
});

async function publishArticle(ctx, session) {
  session.state = 'publishing';
  const article = session.info.article;
  const msg = await ctx.reply('🚀 Публикую на сайт...', Markup.removeKeyboard());

  try {
    const token = await payloadLogin();

    // Upload photos
    const mediaIds = [];
    if (session.photos.length > 0) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '📸 Загружаю фото...');
      for (let i = 0; i < Math.min(session.photos.length, 3); i++) {
        try {
          const buf = await downloadTelegramPhoto(ctx, session.photos[i]);
          const mediaId = await uploadPhotoToPayload(token, buf, `photo-${Date.now()}-${i}.jpg`);
          if (mediaId) mediaIds.push(mediaId);
        } catch {}
      }
    }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '📝 Создаю статью...');
    const result = await createPost(token, article, mediaIds);

    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});

    const url = `${CMS_URL}/blog/${article.slug}`;
    await ctx.reply(
      `✅ *Опубликовано!*\n\n*${article.h1}*\n\n🔗 ${url}\n📸 Фото: ${mediaIds.length} загружено`,
      { parse_mode:'Markdown' }
    );

    resetSession(ctx.chat.id);

  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    session.state = 'awaiting_confirm';
    ctx.reply(
      `❌ Ошибка публикации: *${e.message}*\n\nПроверь настройки CMS в .env файле.\nСтатья сохранена — попробуй ещё раз.`,
      { parse_mode:'Markdown', ...Markup.keyboard([['✅ Публикуй', '❌ Отмена']]).oneTime().resize() }
    );
  }
}

// ─── LAUNCH ──────────────────────────────────────────────────────────────────
bot.launch()
  .then(() => console.log('✅ CrabNorway Bot запущен'))
  .catch(e => console.error('❌ Ошибка запуска:', e));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
