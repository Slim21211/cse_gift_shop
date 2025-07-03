import { Markup, Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import supabase from './lib/supabase';
import { Database } from './types/database';
import axios from 'axios';
import * as xml2js from 'xml2js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

dotenv.config();

const token = process.env.BOT_TOKEN;
const mode = process.env.MODE ?? 'production';

if (!token) throw new Error('BOT_TOKEN не найден');

export const bot = new Telegraf(token);

type Product = Database['public']['Tables']['products']['Row'];

interface Session {
  stage?: 'awaiting_email';
  category?: 'merch' | 'plush';
  index: number;
  products: Product[];
  message_id?: number;
  email?: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
}

const sessions = new Map<number, Session>();

let usersCache: any[] = [];
let tokenInfo: { access_token: string; expires_at: number } | null = null;

const AUTH_FILE = path.resolve(__dirname, 'auth_store.json');
let authStore: Record<string, number> = {};
if (existsSync(AUTH_FILE)) {
  authStore = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
}

function saveAuthStore() {
  writeFileSync(AUTH_FILE, JSON.stringify(authStore));
}

function isAuthorized(user_id: number): boolean {
  const expiresAt = authStore[user_id];
  return typeof expiresAt === 'number' && Date.now() < expiresAt;
}

function setAuthorized(user_id: number): void {
  const month = 1000 * 60 * 60 * 24 * 30;
  authStore[user_id] = Date.now() + month;
  saveAuthStore();
}

async function checkAuthorize(ctx: Context): Promise<boolean> {
  if (!ctx.from) {
    return false;
  }

  const user_id = ctx.from.id;
  if (!isAuthorized(user_id)) {
    await fetchUsers();    
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

// === Получение access token ===
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

// === Получение и парсинг списка пользователей ===
async function fetchUsers(): Promise<void> {
  const accessToken = await getAccessToken();
  const res = await axios.get('https://api-learn.ispringlearn.ru/user/v2', {
    headers: { Authorization: accessToken }
  });

  const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
  const profiles = parsed.response?.userProfileV2;
  usersCache = Array.isArray(profiles) ? profiles : profiles ? [profiles] : [];
}

// === Получение баллов пользователя ===
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

// === Списание баллов пользователя ===
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

// === /start ===
bot.start(async ctx => {
  const user_id = ctx.from.id;  
    sessions.set(user_id, { index: 0, products: [], stage: undefined });

  await fetchUsers();

  await ctx.reply(
    `Привет, ${ctx.from.first_name}!
Для начала авторизуйтесь:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔐 Авторизоваться', 'start_auth')]
    ])
  );
});

// === Начало авторизации ===
bot.action('start_auth', async ctx => {
  const sess = sessions.get(ctx.from.id);  
  if (!sess) return;
  sess.stage = 'awaiting_email';
  await ctx.reply('Введите ваш email для авторизации:');
});

bot.command('account', async ctx => {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.userId) {
    return ctx.reply('Вы не авторизованы. Введите /start для начала.');
  }

  const points = await fetchUserPoints(sess.userId);
  const lines = [
    `👤 ${sess.firstName ?? ''} ${sess.lastName ?? ''}`,
    `📧 Email: ${sess.email ?? 'неизвестен'}`,
    `🆔 ID iSpring: ${sess.userId}`,
    `💰 Баллы: ${points ?? 'не удалось получить'}`
  ];

  ctx.reply(lines.join('\n'));
});

// === Получение email пользователя ===
bot.on('text', async ctx => {
  const user_id = ctx.from.id;
  const sess = sessions.get(user_id);
  const text = ctx.message.text.trim();

  // === Ввод email ===
  if (sess?.stage === 'awaiting_email') {
    const email = text.toLowerCase();
    sess.email = email;
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

      sess.email = email;
      sess.userId = userId;
      sess.firstName = firstName;
      sess.lastName = lastName;

      const points = await fetchUserPoints(userId);      

      await ctx.reply(`Добро пожаловать, ${firstName} ${lastName}`.trim());
      await ctx.reply(`У вас ${points ?? 0} баллов. Вы можете потратить их на покупки.`);
      await ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
        [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
      ]));
    } else {
      await ctx.reply('Пользователь с таким email не найден. Попробуйте снова.');
      sess.stage = 'awaiting_email';
    }

    setAuthorized(ctx.from.id);

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
      .select('quantity, products(name)')
      .eq('user_id', String(user_id));

    if (!data || !data.length) {
      return ctx.reply('Корзина пуста');
    }

    const cartText = data.map((item: any, idx: number) =>
      `${idx + 1}. ${item.products.name} ×${item.quantity}`
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

// --- выбор категории ---
bot.action(/cat_(.+)/, async ctx => {
  await ctx.deleteMessage();
  if (!(await checkAuthorize(ctx))) return;

  const user_id = ctx.from.id;
  const cat = ctx.match[1] as 'merch' | 'plush';

  const { data: products } = await supabase.from('products').select('*');
  if (!products || products.length === 0) return ctx.reply('Нет товаров');

  const sess = sessions.get(user_id) ?? { index: 0, products: [] };
  sess.category = cat;
  sess.index = 0;
  sess.products = products;  

  sessions.set(user_id, sess); // <--- не удаляй старые поля!

  const firstProduct = products[0];
  const caption = `${firstProduct.name} | ${firstProduct.size}\nЦена: ${firstProduct.price}₽\nОсталось: ${firstProduct.remains}`;

  const message = await ctx.replyWithPhoto(firstProduct.image_url ?? '', {
    caption,
    reply_markup: getProductKeyboard(firstProduct.id, 0, products.length, false)
  });

  sess.message_id = message.message_id;
});


// --- генерация инлайн-кнопок под товаром ---
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

// --- обновление товара в уже отправленном сообщении ---
async function updateProductView(ctx: Context, sess: Session, forceInCart?: boolean) {
  const product = sess.products[sess.index];
  if (!product) {
    await ctx.reply('Набор товаров изменился, выберите еще раз:', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
    ]));

    return;
  }
  const caption = `${product.name} | ${product.size}\nЦена: ${product.price}₽\nОсталось: ${product.remains}`;
  if (!sess.message_id) return;

  const { data: cartItems } = await supabase
    .from('cart_items')
    .select('*')
    .eq('user_id', String(ctx.from?.id))
    .eq('product_id', product.id);

  const isInCart = forceInCart ?? !!(cartItems && cartItems.length);

  await ctx.telegram.editMessageMedia(
    ctx.chat!.id,
    sess.message_id,
    undefined,
    {
      type: 'photo',
      media: product.image_url ?? '',
      caption
    },
    {
      reply_markup: getProductKeyboard(product.id, sess.index, sess.products.length, isInCart)
    }
  );
}

// --- перелистывание товаров ---
bot.action(/prev|next|back/, async ctx => {
  const sess = sessions.get(ctx.from.id);
  if (!sess) return;

  if (ctx.match[0] === 'prev') sess.index = Math.max(0, sess.index - 1);
  if (ctx.match[0] === 'next') sess.index = Math.min(sess.products.length - 1, sess.index + 1);
  if (ctx.match[0] === 'back') {
    sess.message_id = undefined;
    await ctx.deleteMessage();
    return ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
      [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
    ]));
  }

  await updateProductView(ctx, sess);
});

// --- добавление в корзину ---
bot.action(/select_(\d+)/, async ctx => {
  const user_id = String(ctx.from.id);
  const product_id = Number(ctx.match[1]);

  const { data } = await supabase.from('cart_items').select('*')
    .eq('user_id', user_id)
    .eq('product_id', product_id);

  if (data && data.length) {
    await supabase.from('cart_items').update({ quantity: data[0].quantity + 1 })
      .eq('user_id', user_id)
      .eq('product_id', product_id);
  } else {
    await supabase.from('cart_items').insert({ user_id, product_id, quantity: 1 });
  }

  await updateProductView(ctx, sessions.get(ctx.from.id)!, true);
  await setCartKeyboard(ctx, user_id, true);
});

// --- удаление из корзины ---
bot.action(/remove_(\d+)/, async ctx => {
  const user_id = String(ctx.from.id);
  const product_id = Number(ctx.match[1]);

  await supabase.from('cart_items').delete()
    .eq('user_id', user_id)
    .eq('product_id', product_id);

  await updateProductView(ctx, sessions.get(ctx.from.id)!, false);
  await setCartKeyboard(ctx, user_id, true);
});

// --- очистка корзины ---
bot.action('clear_cart', async ctx => {
  const user_id = String(ctx.from.id);
  await supabase.from('cart_items').delete().eq('user_id', user_id);

  await setCartKeyboard(ctx, user_id, true);
  await ctx.answerCbQuery('Корзина очищена');
  await ctx.editMessageText('Корзина очищена ✅');

  await ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
  ]));
});

// --- оформление заказа ---
bot.action('order', async ctx => {
  await ctx.answerCbQuery('Проверка заказа...');

  const user_id = String(ctx.from.id);
  const sess = sessions.get(ctx.from.id);  

  if (!sess?.userId) {
    return ctx.reply('Не удалось определить вашего пользователя. Попробуйте заново авторизоваться.');
  }

  const { data } = await supabase
    .from('cart_items')
    .select('quantity, products(name, price)')
    .eq('user_id', user_id);

  if (!data || !data.length) return ctx.reply('Корзина пуста');

  const totalCost = data.reduce((sum, item: any) => sum + item.quantity * item.products.price, 0);

  const userPoints = await fetchUserPoints(sess.userId);

  if (!userPoints || userPoints < totalCost) {
    return ctx.reply(`У вас недостаточно баллов для оформления заказа. Нужно ${totalCost}, у вас ${userPoints ?? 0}.`);
  }

  const success = await withdrawUserPoints(sess.userId, totalCost, 'Списание за заказ в Telegram-боте');

  if (!success) {
    return ctx.reply('Не удалось списать баллы. Попробуйте позже или обратитесь к администратору.');
  }

  // отправка заказа администратору
  const orderText = data.map((i: any) =>
    `${i.products.name} ×${i.quantity}`
  ).join('\n');

  await ctx.telegram.sendMessage(Number(process.env.ADMIN_ID!), `🛍 Новый заказ от ${ctx.from.first_name}:\n${orderText}`);

  // очистка корзины
  await supabase.from('cart_items').delete().eq('user_id', user_id);

  await ctx.reply(`✅ Заказ оформлен и ${totalCost} баллов списано.\nУ вас осталось ${userPoints} баллов.`);
  await setCartKeyboard(ctx, user_id, true);

  await ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
  ]));
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

