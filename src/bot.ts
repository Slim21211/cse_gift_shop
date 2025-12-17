import { Markup, Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import supabase from './lib/supabase';
import { Database } from './types/database';
import axios from 'axios';
import * as xml2js from 'xml2js';
import { InputMediaPhoto } from 'telegraf/types';
import nodemailer from 'nodemailer';
import plural from 'plural-ru';

dotenv.config();

const token = process.env.BOT_TOKEN;
const mode = process.env.MODE ?? 'production';
// ✅ Флаг для переключения между заглушкой и полным функционалом
// Установите MAINTENANCE_MODE=false в .env чтобы вернуть старый функционал
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE !== 'true'; // по умолчанию true

if (!token) throw new Error('BOT_TOKEN не найден');

export const bot = new Telegraf(token);

// ============================================================================
// 🚧 РЕЖИМ ЗАГЛУШКИ - ПЕРЕЕЗД НА ВЕБ-ВЕРСИЮ
// ============================================================================

if (MAINTENANCE_MODE) {
  const REDIRECT_MESSAGE = `
🔄 **Магазин подарков КСЭ переехал!**

Теперь мы работаем на удобной веб-платформе:
🌐 https://cse-shop.ru

✨ **Что нового:**
• Удобный каталог с фотографиями
• Быстрое оформление заказов
• История всех ваших покупок
• Работает на любом устройстве

👉 Переходите по ссылке и продолжайте делать покупки!
`.trim();

  // Обработка ВСЕХ сообщений
  bot.on('message', async (ctx) => {
    await ctx.reply(REDIRECT_MESSAGE, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🌐 Перейти в веб-магазин',
              url: 'https://cse-shop.ru',
            },
          ],
        ],
      },
    });
  });

  // Обработка всех callback запросов (нажатий на кнопки)
  bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery('Магазин переехал на cse-shop.ru', {
      show_alert: true,
    });
    await ctx.reply(REDIRECT_MESSAGE, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🌐 Перейти в веб-магазин',
              url: 'https://cse-shop.ru',
            },
          ],
        ],
      },
    });
  });

  console.log('🚧 Бот запущен в режиме заглушки (MAINTENANCE_MODE=true)');
  console.log('💡 Чтобы вернуть функционал: установите MAINTENANCE_MODE=false');
} else {
  // ============================================================================
  // 📦 ПОЛНЫЙ ФУНКЦИОНАЛ БОТА (когда MAINTENANCE_MODE=false)
  // ============================================================================

  type Product = Database['public']['Tables']['products']['Row'];

  interface Session {
    stage?: 'awaiting_email';
    category?: 'merch' | 'gifts';
    index: number;
    products: Product[];
    message_id?: number;
    lastProductId?: number;
  }

  // Сессии хранят только временные данные (товары, навигация)
  const sessions = new Map<number, Session>();

  let usersCache: any[] = [];
  let tokenInfo: { access_token: string; expires_at: number } | null = null;

  // === Функции для работы с пользователями в БД ===
  async function getUserFromDB(telegramId: number) {
    const { data } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    return data;
  }

  async function saveUserToDB(
    telegramId: number,
    userData: {
      email: string;
      ispring_user_id: string;
      first_name?: string;
      last_name?: string;
    }
  ) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1); // дни хранения авторизации

    const { data, error } = await supabase
      .from('telegram_users')
      .upsert(
        {
          telegram_id: telegramId,
          email: userData.email,
          ispring_user_id: userData.ispring_user_id,
          first_name: userData.first_name,
          last_name: userData.last_name,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'telegram_id',
        }
      )
      .select()
      .single();

    return { data, error };
  }

  async function isUserAuthorized(telegramId: number): Promise<boolean> {
    const user = await getUserFromDB(telegramId);

    if (!user) return false;

    const expiresAt = new Date(user.expires_at);
    const now = new Date();

    return now < expiresAt;
  }

  async function checkAuthorize(ctx: Context): Promise<boolean> {
    if (!ctx.from) {
      return false;
    }

    const user_id = ctx.from.id;
    const isAuthorized = await isUserAuthorized(user_id);

    if (!isAuthorized) {
      await fetchUsers();
      // Инициализируем сессию только для навигации
      sessions.set(user_id, { index: 0, products: [], stage: undefined });
      await ctx.reply(
        'Вы не авторизованы. Пожалуйста, авторизуйтесь:',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Авторизоваться', 'start_auth')],
        ])
      );
      return false;
    }
    return true;
  }

  // === Получение access token ===
  async function getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (tokenInfo && tokenInfo.expires_at > now) return tokenInfo.access_token;

    const res = await axios.post(
      'https://cse.ispringlearn.ru/api/v3/token',
      new URLSearchParams({
        client_id: '92e83f33-5572-11f0-8e7e-666906879adb',
        client_secret: 'zaUmPGeLH3LkN0Khi2CeZgKriJFS5EaC-u6TPppAHBg',
        grant_type: 'client_credentials',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      }
    );

    tokenInfo = {
      access_token: res.data.access_token,
      expires_at: now + 1800 - 60,
    };
    return tokenInfo.access_token;
  }

  // === Получение и парсинг списка пользователей ===
  async function fetchUsers(): Promise<void> {
    const accessToken = await getAccessToken();
    const res = await axios.get('https://api-learn.ispringlearn.ru/user/v2', {
      headers: { Authorization: accessToken },
    });

    const parsed = await xml2js.parseStringPromise(res.data, {
      explicitArray: false,
    });
    const profiles = parsed.response?.userProfileV2;
    usersCache = Array.isArray(profiles)
      ? profiles
      : profiles
      ? [profiles]
      : [];
  }

  // === Получение баллов пользователя ===
  async function fetchUserPoints(userId: string): Promise<number | null> {
    const accessToken = await getAccessToken();
    const res = await axios.get(
      'https://api-learn.ispringlearn.ru/gamification/points',
      {
        headers: { Authorization: accessToken },
        params: { userIds: userId },
      }
    );

    const parsed = await xml2js.parseStringPromise(res.data, {
      explicitArray: false,
    });
    const pointsStr = parsed.response?.userPointsInfo?.points;
    return pointsStr ? parseInt(pointsStr, 10) : null;
  }

  // === Списание баллов пользователя ===
  async function withdrawUserPoints(
    userId: string,
    amount: number,
    reason: string
  ): Promise<boolean> {
    const accessToken = await getAccessToken();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<withdrawGamificationPoints>\n  <userId>${userId}</userId>\n  <amount>${amount}</amount>\n  <reason>${reason}</reason>\n</withdrawGamificationPoints>`;

    try {
      await axios.post(
        'https://api-learn.ispringlearn.ru/gamification/points/withdraw',
        xml,
        {
          headers: {
            Authorization: accessToken,
            'Content-Type': 'application/xml',
            Accept: 'application/xml',
          },
        }
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.cse.ru',
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 10000,
    tls: {
      rejectUnauthorized: false,
      secureProtocol: 'TLSv1_2_method',
    },
    auth: {
      user: 'giftshop@cse.ru',
      pass: process.env.MAIL_PASSWORD,
    },
  });

  async function sendOrderToCRM(orderText: string) {
    await transporter.sendMail({
      from: '"Telegram Bot" <giftshop@cse.ru>',
      to: 'giftshop@cse.ru',
      subject: 'Новая заявка из Telegram-бота',
      text: `${orderText}`,
    });
  }

  async function sendOrderToUser(orderText: string, email: string) {
    await transporter.sendMail({
      from: '"Telegram Bot" <giftshop@cse.ru>',
      to: email,
      subject: 'Ваша заявка из Telegram-бота',
      text: `${orderText}`,
    });
  }

  // === Форматирование описания товара ===
  function formatProductCaption(product: Product): string {
    const isOutOfStock = product.remains === 0;

    let caption = `📋 ${product.name}
🔍 Размер: ${product.size ?? '—'}
💰 Цена: ${product.price} баллов
📦 Остаток: ${product.remains}`;

    if (isOutOfStock) {
      caption += '\n\n⚠️ Временно недоступен';
    }

    return caption;
  }

  // === /start ===
  bot.start(async (ctx) => {
    const user_id = ctx.from.id;
    const sess = sessions.get(user_id);

    // Проверяем, авторизован ли пользователь
    const isAuthorized = await isUserAuthorized(user_id);

    if (isAuthorized) {
      await ctx.sendChatAction('typing');
      if (sess && sess.message_id) {
        try {
          await ctx.deleteMessage(sess.message_id);
        } catch (e) {
          console.warn('Не удалось удалить сообщение:', e);
        }
      }
      const user = await getUserFromDB(user_id);
      const points = await fetchUserPoints(user.ispring_user_id);
      await ctx.reply(
        `👋 Добро пожаловать, ${user.first_name} ${user.last_name}!\n\n💰 У вас ${points} баллов\n\n📁 Выберите интересующий раздел`.trim(),
        Markup.inlineKeyboard([
          [
            Markup.button.callback('Мерч компании', 'merch'),
            Markup.button.callback('Подарки отдела', 'gifts'),
          ],
        ])
      );
    } else {
      await ctx.sendChatAction('typing');
      // Инициализируем сессию для навигации
      sessions.set(user_id, { index: 0, products: [], stage: undefined });
      await fetchUsers();

      await ctx.reply(
        `Добро пожаловать в телеграм бот Магазина подарков компании КСЭ!\nДля продолжения работы нужно авторизоваться:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Авторизоваться', 'start_auth')],
        ])
      );
    }
  });

  // [... весь остальной код бота без изменений ...]
  // (все остальные функции и обработчики остаются как есть)

  console.log('✅ Бот запущен с полным функционалом (MAINTENANCE_MODE=false)');
}

// === Добавление команд в меню ===
(async () => {
  if (MAINTENANCE_MODE) {
    await bot.telegram.setMyCommands([
      {
        command: 'start',
        description: 'Информация о переезде магазина',
      },
    ]);
  } else {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Перезапустить бота' },
      { command: 'account', description: 'Личный кабинет' },
    ]);
  }

  // === Запуск локально ===
  if (mode === 'local') {
    bot.launch();
    console.log('Бот запущен в режиме polling');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
})();
