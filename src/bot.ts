import { Markup, Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import supabase from './lib/supabase';
import { Database } from './types/database';
import axios from 'axios';
import * as xml2js from 'xml2js';
import { InputMediaPhoto } from 'telegraf/types';
import nodemailer from 'nodemailer';

dotenv.config();

const token = process.env.BOT_TOKEN;
const mode = process.env.MODE ?? 'production';

if (!token) throw new Error('BOT_TOKEN не найден');

export const bot = new Telegraf(token);

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

async function saveUserToDB(telegramId: number, userData: {
  email: string;
  ispring_user_id: string;
  first_name?: string;
  last_name?: string;
}) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 1); // дни хранения авторизации

  const { data, error } = await supabase
    .from('telegram_users')
    .upsert({
      telegram_id: telegramId,
      email: userData.email,
      ispring_user_id: userData.ispring_user_id,
      first_name: userData.first_name,
      last_name: userData.last_name,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'telegram_id'
    })
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
        [Markup.button.callback('🔐 Авторизоваться', 'start_auth')]
      ])
    );
    return false;
  }
  return true;
}

// === Получение access token (без изменений) ===
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenInfo && tokenInfo.expires_at > now) return tokenInfo.access_token;

  const res = await axios.post('https://cse.ispringlearn.ru/api/v3/token', new URLSearchParams({
    client_id: '92e83f33-5572-11f0-8e7e-666906879adb',
    client_secret: 'zaUmPGeLH3LkN0Khi2CeZgKriJFS5EaC-u6TPppAHBg',
    grant_type: 'client_credentials'
  }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
  });

  tokenInfo = {
    access_token: res.data.access_token,
    expires_at: now + 1800 - 60
  };
  return tokenInfo.access_token;
}

// === Получение и парсинг списка пользователей (без изменений) ===
async function fetchUsers(): Promise<void> {
  const accessToken = await getAccessToken();
  const res = await axios.get('https://api-learn.ispringlearn.ru/user/v2', {
    headers: { Authorization: accessToken }
  });

  const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
  const profiles = parsed.response?.userProfileV2;
  usersCache = Array.isArray(profiles) ? profiles : profiles ? [profiles] : [];  
}

// === Получение баллов пользователя (без изменений) ===
async function fetchUserPoints(userId: string): Promise<number | null> {
  const accessToken = await getAccessToken();
  const res = await axios.get('https://api-learn.ispringlearn.ru/gamification/points', {
    headers: { Authorization: accessToken },
    params: { userIds: userId }
  });

  const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
  const pointsStr = parsed.response?.userPointsInfo?.points;
  return pointsStr ? parseInt(pointsStr, 10) : null;
}

// === Списание баллов пользователя (без изменений) ===
async function withdrawUserPoints(userId: string, amount: number, reason: string): Promise<boolean> {
  const accessToken = await getAccessToken();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<withdrawGamificationPoints>\n  <userId>${userId}</userId>\n  <amount>${amount}</amount>\n  <reason>${reason}</reason>\n</withdrawGamificationPoints>`;

  try {
    await axios.post('https://api-learn.ispringlearn.ru/gamification/points/withdraw', xml, {
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/xml',
        Accept: 'application/xml'
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

const transporter = nodemailer.createTransport({
  host: 'smtp.yandex.ru',
  port: 465, // или 587
  secure: true, // true для 465, false для 587
  auth: {
    user: 'GiftsShopCSE@yandex.ru',
    pass: process.env.MAIL_PASSWORD,
  },
});

async function sendOrderToCRM(orderText: string) {
  await transporter.sendMail({
    from: '"Telegram Bot" <GiftsShopCSE@yandex.ru>',
    to: 'giftshop@cse.ru',
    subject: 'Новая заявка из Telegram-бота',
    text: `${orderText}`,
  });
}

// === /start ===
bot.start(async ctx => {
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
        [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
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
        [Markup.button.callback('🔐 Авторизоваться', 'start_auth')]
      ])
    );
  }
});

// === Начало авторизации ===
bot.action('start_auth', async ctx => {
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const user_id = ctx.from.id;
  let sess = sessions.get(user_id);
  
  if (!sess) {
    sess = { index: 0, products: [], stage: undefined };
    sessions.set(user_id, sess);
  }
  
  sess.stage = 'awaiting_email';
  await ctx.reply('Введите вашу рабочую почту для авторизации:');
});

// === Команда /account ===
bot.command('account', async ctx => {
  const sess = sessions.get(ctx.from.id);
  
  const user_id = ctx.from.id;
  const user = await getUserFromDB(user_id);
  
  if (!user) {
    await ctx.deleteMessage();
    if (sess && sess.message_id) {
      try {
        await ctx.deleteMessage(sess.message_id);
      } catch (e) {
        console.warn('Не удалось удалить сообщение:', e);
      }
    }
    await ctx.sendChatAction('typing');
    return ctx.reply('✖️ Вы не авторизованы. Введите /start для начала.');
  }

  const points = await fetchUserPoints(user.ispring_user_id);
  const lines = [
    `👤 ${user.first_name ?? ''} ${user.last_name ?? ''}`,
    `📧 Email: ${user.email ?? 'неизвестен'}`,
    `💰 Баллы: ${points ?? 'не удалось получить'}`
  ];

  await ctx.deleteMessage();
  if (sess && sess.message_id) {
    try {
      await ctx.deleteMessage(sess.message_id);
    } catch (e) {
      console.warn('Не удалось удалить сообщение:', e);
    }
  }
  ctx.reply(lines.join('\n\n'), Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Вернуться к покупкам', 'return_to_products')],
  ]));
});

// === Получение email пользователя ===
bot.on('text', async ctx => {
  const user_id = ctx.from.id;
  const sess = sessions.get(user_id);
  const text = ctx.message.text.trim();

  // === Ввод email ===
  if (sess?.stage === 'awaiting_email') {
    const email = text.toLowerCase();
    sess.stage = undefined;

    const matchedUser = usersCache.find(user => {
      const fields = user.fields?.field;
      const emailField = Array.isArray(fields)
        ? fields.find(f => f.name === 'EMAIL')
        : fields?.name === 'EMAIL' ? fields : null;
      return emailField?.value?.toLowerCase() === email;
    });

    if (matchedUser) {
      const fields = matchedUser.fields?.field;
      const firstName = Array.isArray(fields) ? fields.find(f => f.name === 'FIRST_NAME')?.value : '';
      const lastName = Array.isArray(fields) ? fields.find(f => f.name === 'LAST_NAME')?.value : '';
      const userId = matchedUser.userId;

      // Сохраняем пользователя в БД
      await saveUserToDB(user_id, {
        email,
        ispring_user_id: userId,
        first_name: firstName,
        last_name: lastName
      });

      const points = await fetchUserPoints(userId);

      await ctx.reply(
        `👋 Добро пожаловать, ${firstName} ${lastName}!\n\n💰 У вас ${points} баллов\n\n📁 Выберите интересующий раздел`.trim(),
        Markup.inlineKeyboard([
          [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
        ])
      );
    } else {
      await ctx.reply('Пользователь с таким email не найден. Попробуйте снова.');
      sess.stage = 'awaiting_email';
    }

    return;
  }

  // === Обработка нажатия на кнопку "🛒 Корзина" ===
  if (/^🛒 Корзина/.test(text)) {
    const sess = sessions.get(user_id);
    if (sess && sess.message_id) {
      try {
        await ctx.deleteMessage(sess.message_id);
      } catch (e) {
        console.warn('Не удалось удалить сообщение:', e);
      }
    }

    const { data } = await supabase
      .from('cart_items')
      .select('quantity, products(name), price')
      .eq('user_id', String(user_id));

    if (!data || !data.length) {
      return ctx.reply('🚫 В корзине пока нет товаров');
    }    

    const cartText = data.map((item: any, idx: number) =>
      `${idx + 1}. ${item.products.name} - ${item.quantity} шт.\nСтоимость: ${item.price} баллов`
    ).join('\n');

    await ctx.reply(`🛒 Ваша корзина:\n${cartText}`, Markup.inlineKeyboard([
      [Markup.button.callback('Заказать ✅', 'order')],
      [Markup.button.callback('🧹 Очистить', 'clear_cart')]
    ]));
    return;
  }

  // === Остальные сообщения — опционально логируем ===
  console.log(`Получено сообщение от ${ctx.from.username || ctx.from.first_name}: ${text}`);
});

// --- клавиатура Корзина (n) ---
async function setCartKeyboard(ctx: any, user_id: string, notify: boolean = false) {
  const { data } = await supabase.from('cart_items').select('quantity').eq('user_id', user_id);
  const total = (data ?? []).reduce((sum, item) => sum + item.quantity, 0);

  if (!notify) {
    return;
  }

  await ctx.telegram.sendMessage(ctx.chat.id, `🛒 Корзина обновлена (${total})`, {
    reply_markup: {
      keyboard: [[{ text: `🛒 Корзина (${total})` }]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
}

// --- возврат к товарам ---
bot.action('return_to_products', async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  await ctx.deleteMessage();
  await ctx.reply('📁 Выберите интересующий раздел', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
  ]))
});

// --- выбор категории ---
bot.action('merch', async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  await ctx.deleteMessage();
  if (!(await checkAuthorize(ctx))) return;

  const user_id = ctx.from.id;

  // Только товары (is_gift = false)
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('is_gift', false);

  if (!products || products.length === 0) {
    return ctx.reply('❌ Нет доступных товаров');
  }

  const availableProducts = products.filter(product => product.remains > 0);

  if (availableProducts.length === 0) {
    return ctx.reply('❌ Все товары закончились');
  }

  let sess = sessions.get(user_id);
  if (!sess) {
    sess = { index: 0, products: [] };
    sessions.set(user_id, sess);
  }

  sess.category = 'merch';
  sess.index = 0;
  sess.products = availableProducts;

  const firstProduct = availableProducts[0];
  const caption = `📋 ${firstProduct.name}
    🔍 Размер: ${firstProduct.size ?? '—'}
    💰 Цена: ${firstProduct.price} баллов
    📦 Остаток: ${firstProduct.remains}`;

  const message = await ctx.replyWithPhoto(firstProduct.image_url ?? '', {
    caption,
    reply_markup: getProductKeyboard(firstProduct.id, 0, availableProducts.length, false),
  });

  sess.message_id = message.message_id;
});


bot.action('gifts', async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  await ctx.deleteMessage();
  if (!(await checkAuthorize(ctx))) return;

  const { data: gifts, error } = await supabase
    .from('products')
    .select('*')
    .gt('remains', 0) // Только подарки с остатками
    .order('id')
    .eq('is_gift', true)

  if (error || !gifts || gifts.length === 0) {
    await ctx.reply('Не удалось получить список подарков или они закончились 😢');
    return;
  }

  const messageText = `🎁 Выберите подарок из списка:\n\n` +
    gifts.map((gift, index) => `${index + 1}. ${gift.name} — ${gift.price} баллов`).join('\n');

  const keyboard = gifts.map((gift, index) => [
    Markup.button.callback(`${index + 1} — ${gift.price} баллов`, `select_gift_${gift.id}`)
  ]);

  keyboard.push([Markup.button.callback('Назад ◀️', 'back')]);

  await ctx.reply(messageText, Markup.inlineKeyboard(keyboard));
});

bot.action(/select_gift_(\d+)/, async ctx => {
  
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  await ctx.deleteMessage();

  const user_id = String(ctx.from.id);
  const product_id = Number(ctx.match[1]);
  
  // Получаем информацию о подарке из products
  const { data: product } = await supabase
    .from('products')
    .select('remains, price, name, is_gift')
    .eq('id', product_id)
    .eq('is_gift', true)
    .single();

  if (!product?.remains) {
    return ctx.answerCbQuery('❌ К сожалению, данный подарок закончился', { show_alert: true });
  }

  const { data: cartItem } = await supabase
    .from('cart_items')
    .select('quantity, price')
    .eq('user_id', user_id)
    .eq('product_id', product_id)
    .single();

  const currentQuantity = cartItem?.quantity || 0;

  if (currentQuantity >= product.remains) {
    return ctx.answerCbQuery('❌ К сожалению, данный подарок закончился', { show_alert: true });
  }

  if (cartItem) {
    const newQuantity = currentQuantity + 1;
    await supabase
      .from('cart_items')
      .update({ quantity: newQuantity, price: newQuantity * product.price })
      .eq('user_id', user_id)
      .eq('product_id', product_id);
  } else {
    const { error } = await supabase
      .from('cart_items')
      .insert({ user_id, product_id, quantity: 1, price: product.price });

    if (error) {
      console.error('Ошибка при добавлении подарка в корзину:', error.message);
      return ctx.answerCbQuery('❌ Не удалось добавить подарок в корзину', { show_alert: true });
    }
  }

  await ctx.answerCbQuery(`✅ ${product.name} добавлен в корзину`);
  await setCartKeyboard(ctx, user_id, true);
});


// --- генерация инлайн-кнопок под товаром (без изменений) ---
function getProductKeyboard(productId: number, index: number, total: number, isInCart: boolean) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️', 'prev'),
      Markup.button.callback(`${index + 1}/${total}`, 'noop'),
      Markup.button.callback('➡️', 'next')
    ],
    [isInCart
      ? Markup.button.callback('Удалить 🗑️', `remove_${productId}`)
      : Markup.button.callback('Выбрать 🎯', `select_${productId}`)],
    [Markup.button.callback('Назад ◀️', 'back')]
  ]).reply_markup;
}

// --- обновление товара в уже отправленном сообщении (без изменений) ---
async function updateProductView(ctx: Context, sess: Session, forceInCart?: boolean) {
  const product = sess.products[sess.index];
  if (!product) {
    await ctx.reply('📁 Набор товаров изменился, выберите еще раз:', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
    ]));
    return;
  }

  // Проверка на дубликат продукта и не форсированный апдейт
  if (sess.lastProductId === product.id && !forceInCart) {
    return;
  }

  sess.lastProductId = product.id;

  const caption = `📋 ${product.name}\n🔍 Размер: ${product.size}\n💰 Цена: ${product.price} баллов\n📦 Остаток: ${product.remains}`;
  if (!sess.message_id) return;

  const { data: cartItems } = await supabase
    .from('cart_items')
    .select('*')
    .eq('user_id', String(ctx.from?.id))
    .eq('product_id', product.id);

  const isInCart = forceInCart ?? !!(cartItems && cartItems.length);
  const media: InputMediaPhoto = {
    type: 'photo',
    media: product.image_url ?? '',
    caption
  };
  const reply_markup = getProductKeyboard(product.id, sess.index, sess.products.length, isInCart);

  try {
    await ctx.telegram.editMessageMedia(
      ctx.chat!.id,
      sess.message_id,
      undefined,
      media,
      { reply_markup }
    );
  } catch (err: any) {
    if (err?.description?.includes('message is not modified')) {
      // Просто игнорируем
      console.warn('⏭ Пропущено обновление: контент не изменился');
    } else {
      throw err;
    }
  }
}

// --- перелистывание товаров (без изменений) ---
bot.action(/prev|next|back/, async ctx => {
  await ctx.answerCbQuery('Загрузка товаров...');
  const sess = sessions.get(ctx.from.id);
  if (!sess) {
    ctx.deleteMessage();
    return ctx.reply('📁 Выберите интересующий раздел', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
    ]));
  }

  if (ctx.match[0] === 'prev') sess.index = Math.max(0, sess.index - 1);
  if (ctx.match[0] === 'next') sess.index = Math.min(sess.products.length - 1, sess.index + 1);
  if (ctx.match[0] === 'back') {
    sess.message_id = undefined;
    await ctx.deleteMessage();
    return ctx.reply('📁 Выберите интересующий раздел', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
    ]));
  }

  await updateProductView(ctx, sess);
});

// --- добавление в корзину с проверкой остатков ---
bot.action(/select_(\d+)/, async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  const user_id = String(ctx.from.id);
  const product_id = Number(ctx.match[1]);
 
  // Получаем информацию о товаре
  const { data: product } = await supabase
    .from('products')
    .select('remains, price')
    .eq('id', product_id)
    .single();  
 
  if (!product?.remains) {
    await ctx.deleteMessage();
    return ctx.reply('❌ К сожалению, данная позиция закончилась', Markup.inlineKeyboard([Markup.button.callback('⬅️ Вернуться к покупкам', 'return_to_products')]));
  }  
 
  // Проверяем текущее количество в корзине
  const { data: cartItem } = await supabase
    .from('cart_items')
    .select('quantity, price')
    .eq('user_id', user_id)
    .eq('product_id', product_id)
    .single();    
 
  const currentQuantity = cartItem?.quantity || 0;
  const currentPrice = cartItem?.price || 0;  
 
  // Проверяем, можно ли добавить еще один товар
  if (currentQuantity >= (product.remains || 0)) {
    return ctx.answerCbQuery('❌ К сожалению, данная позиция закончилась', { show_alert: true });
  }
 
  // Добавляем товар в корзину  
  if (cartItem) {
    const newQuantity = currentQuantity + 1;
    await supabase
      .from('cart_items')
      .update({ quantity: newQuantity, price: newQuantity * product.price })
      .eq('user_id', user_id)
      .eq('product_id', product_id);
  } else {
    await supabase
      .from('cart_items')
      .insert({ user_id, product_id, quantity: 1, price: product.price });
  }
 
  await updateProductView(ctx, sessions.get(ctx.from.id)!, true);
  await setCartKeyboard(ctx, user_id, true);
 });

// --- удаление из корзины (без изменений) ---
bot.action(/remove_(\d+)/, async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  const user_id = String(ctx.from.id);
  const product_id = Number(ctx.match[1]);

  await supabase.from('cart_items').delete()
    .eq('user_id', user_id)
    .eq('product_id', product_id);

  await updateProductView(ctx, sessions.get(ctx.from.id)!, false);
  await setCartKeyboard(ctx, user_id, true);
});

// --- очистка корзины (без изменений) ---
bot.action('clear_cart', async ctx => {
  await ctx.answerCbQuery('');
  await ctx.sendChatAction('typing');
  const user_id = String(ctx.from.id);
  await supabase.from('cart_items').delete().eq('user_id', user_id);

  await setCartKeyboard(ctx, user_id, true);
  await ctx.answerCbQuery('Корзина очищена');
  await ctx.editMessageText('Корзина очищена ✅');

  await ctx.reply('📁 Выберите интересующий раздел', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
  ]));
});

// --- оформление заказа ---
bot.action('order', async ctx => {
  await ctx.answerCbQuery('Проверка заказа...');
  await ctx.sendChatAction('typing');

  const user_id = String(ctx.from.id);
  const user = await getUserFromDB(ctx.from.id);

  if (!user) {
    return ctx.reply('Не удалось определить вашего пользователя. Попробуйте заново авторизоваться: /start');
  }

  const { data, error } = await supabase
    .from('cart_items')
    .select('quantity, product_id, products(name, price, remains), price')
    .eq('user_id', user_id);

  if (error) {
    console.error('Ошибка при получении корзины:', error);
    return ctx.reply('Не удалось получить данные корзины. Попробуйте позже.');
  }

  if (!data || data.length === 0) {
    return ctx.reply('🚫 В корзине пока нет товаров');
  }

  // Тип ответа от Supabase
  type RawCartItem = {
    quantity: number;
    product_id: number;
    products: {
      name: string;
      price: number;
      remains: number;
    }[];
    price: number;
  };

  // Целевой тип, с которым будем работать
  type CartItemWithProduct = {
    quantity: number;
    product_id: number;
    product: {
      name: string;
      price: number;
      remains: number;
    } | null;
    price: number;
  };

  const rawCartItems = data as RawCartItem[];

  const cartItems: CartItemWithProduct[] = rawCartItems.map(item => ({
    quantity: item.quantity,
    product_id: item.product_id,
    product: Array.isArray(item.products) ? item.products[0] : item.products ?? null,
    price: item.price,
  }));  
  
  // Проверяем наличие всех продуктов
  const invalidItems = cartItems.filter(item => !item.product);
  if (invalidItems.length > 0) {
    return ctx.reply('Некоторые товары устарели или были удалены. Обновите корзину.');
  }

  // Проверяем остатки
  const insufficientStock = cartItems.filter(item =>
    item.product && item.quantity > item.product.remains
  );

  if (insufficientStock.length > 0) {
    const stockErrors = insufficientStock.map(item =>
      `${item.product!.name}: нужно ${item.quantity}, в наличии ${item.product!.remains}`
    ).join('\n');

    return ctx.reply(`❌ Вы заказали больше, чем осталось:\n${stockErrors}`);
  }

  const totalCost = cartItems.reduce((sum, item) =>
    sum + item.quantity * (item.product!.price), 0
  );

  const userPoints = await fetchUserPoints(user.ispring_user_id);

  if (!userPoints || userPoints < totalCost) {
    return ctx.reply(`❌ У вас недостаточно баллов для оформления заказа. Нужно ${totalCost}, у вас ${userPoints ?? 0}.`, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Вернуться к покупкам', 'return_to_products')],
    ]));
  }

  try {
    // Списание баллов
    const success = await withdrawUserPoints(user.ispring_user_id, totalCost, 'Списание за заказ в Telegram-боте');

    if (!success) {
      return ctx.reply('❌ Не удалось списать баллы. Попробуйте позже или обратитесь к администратору.');
    }

    // Обновление остатков
    for (const item of cartItems) {
      const newRemains = item.product!.remains - item.quantity;

      const { error } = await supabase
        .from('products')
        .update({ remains: newRemains })
        .eq('id', item.product_id);

      if (error) {
        console.error(`Ошибка при обновлении остатков товара ${item.product!.name}:`, error);
      }
    }

    // Отправка заказа админу
    const orderContain = cartItems.map((item, index) =>
      `${index + 1}. ${item.product!.name} - ${item.quantity} шт.\nСтоимость: ${item.price} баллов\n`
    ).join('\n');

    const orderText = `🛍 Новый заказ!!!\n\n👨 ${user.first_name} ${user.last_name}\n📨 ${user.email}\n🌍 @${ctx.from.username}\n\n📋 Заказ:\n${orderContain}\n\n💰 Общая стоимость: ${totalCost} баллов`

    await ctx.telegram.sendMessage(Number(process.env.ADMIN_ID!), orderText);

    await sendOrderToCRM(orderText)

    // Очистка корзины
    await supabase.from('cart_items').delete().eq('user_id', user_id);

    await ctx.reply(`✅ Заказ оформлен и ${totalCost} баллов списано.\nУ вас осталось ${userPoints - totalCost} баллов.\n\nДля подтверждения заказа Вам поступит письмо на рабочую почту.`);
    await setCartKeyboard(ctx, user_id, true);

    await ctx.reply('📁 Продолжите покупки, выбрав соответствующий раздел', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч компании', 'merch'), Markup.button.callback('Подарки отдела', 'gifts')]
    ]));
    
  } catch (err) {
    console.error('Ошибка при оформлении заказа:', err);
    return ctx.reply('❌ Произошла ошибка при оформлении заказа. Попробуйте позже.');
  }
});

// === Добавление команд в меню ===
(async () => {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Перезапустить бота' },
    { command: 'account', description: 'Личный кабинет' }
  ]);

  // === Запуск локально ===
  if (mode === 'local') {
    bot.launch();
    console.log('Бот запущен в режиме polling');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
})();
