import { Markup, Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import supabase from './lib/supabase';
import { Database } from './types/database';

dotenv.config();

const token = process.env.BOT_TOKEN;
const mode = process.env.MODE ?? 'production';

type Product = Database['public']['Tables']['products']['Row'];

interface Session {
  category?: 'merch' | 'plush';
  index: number;
  products: Product[];
  message_id?: number;
}

const sessions = new Map<number, Session>();

if (!token) throw new Error('BOT_TOKEN не найден');

export const bot = new Telegraf(token);

// --- /start ---
bot.start(async ctx => {
  const user_id = ctx.from.id;
  sessions.set(user_id, { index: 0, products: [] });

  await ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
  ]));

  await setCartKeyboard(ctx, String(user_id));
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
  const user_id = ctx.from.id;
  const cat = ctx.match[1] as 'merch' | 'plush';
  const size = cat === 'merch' ? 'M' : 'P';

  const { data: products } = await supabase.from('products').select('*').eq('size', size);
  if (!products || products.length === 0) return ctx.reply('Нет товаров');

  const sess: Session = { category: cat, index: 0, products };
  sessions.set(user_id, sess);

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

// --- просмотр корзины ---
bot.hears(/^🛒 Корзина/, async ctx => {
  const user_id = String(ctx.from.id);
  const { data } = await supabase
    .from('cart_items')
    .select('quantity, products(name)')
    .eq('user_id', user_id);

  if (!data || !data.length) return ctx.reply('Корзина пуста');

  const text = data.map((item: any, idx: number) =>
    `${idx + 1}. ${item.products.name} ×${item.quantity}`
  ).join('\n');

  await ctx.reply(`🛒 Ваша корзина:\n${text}`, Markup.inlineKeyboard([
    [Markup.button.callback('Заказать ✅', 'order')],
    [Markup.button.callback('🧹 Очистить', 'clear_cart')]
  ]));
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
  await ctx.answerCbQuery('Отправка памятки...');
  const user_id = String(ctx.from.id);
  const { data } = await supabase
    .from('cart_items')
    .select('quantity, products(name)')
    .eq('user_id', user_id);

  if (!data || !data.length) return ctx.reply('Корзина пуста');

  const text = data.map((i: any) =>
    `${i.products.name} ×${i.quantity}`
  ).join('\n');

  await ctx.telegram.sendMessage(Number(process.env.ADMIN_ID!), `Новый заказ от ${ctx.from.first_name}:\n${text}`);
  await supabase.from('cart_items').delete().eq('user_id', user_id);

  await ctx.reply('Заказ отправлен администратору!');
  await setCartKeyboard(ctx, user_id, true);

  await ctx.reply('Выберите раздел:', Markup.inlineKeyboard([
    [Markup.button.callback('Мерч', 'cat_merch'), Markup.button.callback('Плюшки', 'cat_plush')]
  ]));
});

// --- запуск в local ---
if (mode === 'local') {
  bot.launch();
  console.log('Бот запущен в режиме polling');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}