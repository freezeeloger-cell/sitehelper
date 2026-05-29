# CrabNorway Content Bot 🦀

Telegram-бот — правая рука для публикации контента на CrabNorway.com.

## Что умеет

- Принимает задачу текстом + фото прямо в Telegram
- Задаёт уточняющие вопросы если чего-то не хватает
- Сам ищет актуальные факты в интернете
- Пишет SEO-оптимизированную статью в стиле Даниила
- Показывает превью перед публикацией
- Загружает фото и публикует напрямую в Payload CMS

---

## Установка (5 минут)

### 1. Создай бота в Telegram
1. Открой [@BotFather](https://t.me/BotFather)
2. Напиши `/newbot`
3. Дай имя: `CrabNorway Content`
4. Скопируй **токен** вида `123456789:AAF...`

### 2. Получи Anthropic API ключ
Зайди на [console.anthropic.com](https://console.anthropic.com), создай ключ.

### 3. Настрой .env
```bash
cp .env.example .env
nano .env   # или открой в любом редакторе
```

Заполни:
```
TELEGRAM_BOT_TOKEN=  ← токен от BotFather
ANTHROPIC_API_KEY=   ← ключ от Anthropic
PAYLOAD_URL=https://crabnorway.com
PAYLOAD_EMAIL=       ← твой email от Payload /admin
PAYLOAD_PASS=        ← твой пароль от Payload /admin
PAYLOAD_COLLECTION=posts  ← название коллекции (уточни в Payload)
```

### 4. Установи зависимости и запусти
```bash
npm install
npm start
```

---

## Деплой (чтобы работал постоянно)

### Вариант A — Railway.app (проще всего, бесплатно)
1. Зайди на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub → загрузи папку
3. В Variables добавь все переменные из .env
4. Deploy — готово, бот работает 24/7

### Вариант B — VPS (если уже есть сервер)
```bash
# Установи pm2
npm install -g pm2

# Запусти
pm2 start bot.js --name crabnorway-bot
pm2 save
pm2 startup
```

---

## Как пользоваться

**Простая задача:**
```
Напиши кейс про Богдана из Одессы, 
который попал на краболов без опыта
```

**С разделом:**
```
Блог: гайд по STCW сертификатам для новичков
```

**С фото:**
Прикрепи фото → напиши задачу в подписи

**Команды:**
- `/start` — начало работы
- `/reset` — сбросить текущую задачу
- `/status` — посмотреть текущий статус

---

## Структура файлов

```
crabnorway-bot/
├── bot.js          ← основной файл
├── .env            ← твои ключи (не коммить в git!)
├── .env.example    ← шаблон
└── package.json
```
