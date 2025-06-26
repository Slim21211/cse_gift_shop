import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../src/bot';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Failed to handle update:', err);
    res.status(200).send('ok');
  }
}
