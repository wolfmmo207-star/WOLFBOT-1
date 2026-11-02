const { randomInt } = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const gzw = require('../config/gzw');

const DAY_MS = 86400000;
let polling = false;

function config() {
  const token = process.env.SEPAY_API_TOKEN;
  const accountNo = process.env.SEPAY_ACCOUNT_NO;
  if (!token || !accountNo) throw new Error('Thiếu cấu hình SEPAY_API_TOKEN hoặc SEPAY_ACCOUNT_NO');
  const prefix = (process.env.DONATE_ORDER_PREFIX || 'GZW').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'GZW';
  return {
    token,
    accountNo,
    bankId: process.env.SEPAY_BANK_ID || 'MBBank',
    accountName: process.env.SEPAY_ACCOUNT_NAME || '',
    prefix
  };
}

function makeOrderCode() {
  let orderCode;
  do {
    orderCode = Date.now() * 1000 + randomInt(1000);
  } while (!Number.isSafeInteger(orderCode) || db.prepare('SELECT 1 FROM donation_orders WHERE orderCode = ?').get(orderCode));
  return orderCode;
}

function createDonationOrder({ guildId, userId, amount }) {
  if (!Number.isInteger(amount) || amount < 2000 || amount > 200000000) {
    throw new Error('Số tiền donate không hợp lệ');
  }
  const settings = config();
  const orderCode = makeOrderCode();
  const transferContent = `${settings.prefix}${orderCode}`;
  const qrUrl = new URL('https://vietqr.app/img');
  qrUrl.searchParams.set('acc', settings.accountNo);
  qrUrl.searchParams.set('bank', settings.bankId);
  qrUrl.searchParams.set('amount', String(amount));
  qrUrl.searchParams.set('des', transferContent);
  if (settings.accountName) qrUrl.searchParams.set('accountName', settings.accountName);

  db.prepare(`INSERT INTO donation_orders (orderCode, guildId, userId, amount, checkoutUrl, status, createdAt)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`)
    .run(orderCode, guildId, userId, amount, qrUrl.toString(), Date.now());
  return { orderCode, amount, transferContent, qrUrl: qrUrl.toString() };
}

function localDateTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function fetchTransactions(settings) {
  const configuredDays = Number(process.env.SEPAY_LOOKBACK_DAYS || 2);
  const days = Number.isFinite(configuredDays) ? configuredDays : 2;
  const since = localDateTime(new Date(Date.now() - Math.max(1, Math.min(days, 30)) * DAY_MS));
  const url = new URL('https://my.sepay.vn/userapi/transactions/list');
  url.searchParams.set('limit', '500');
  url.searchParams.set('transaction_date_min', since);
  url.searchParams.set('account_number', settings.accountNo);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`SePay HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.transactions)) throw new Error('Phản hồi SePay thiếu danh sách giao dịch');
  return body.transactions;
}

function extractOrderCode(tx, prefix) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedPrefix}(\\d{10,16})`, 'i');
  for (const text of [tx.code, tx.transaction_content]) {
    const match = pattern.exec(String(text || ''));
    if (match) return Number(match[1]);
  }
  return null;
}

async function notifyPaidDonation(client, orderCode) {
  const claimed = db.prepare(`UPDATE donation_orders SET notificationStatus = 'SENDING'
    WHERE orderCode = ? AND status = 'PAID' AND notificationStatus = 'PENDING'`).run(orderCode).changes;
  if (!claimed) return false;

  const order = db.prepare('SELECT * FROM donation_orders WHERE orderCode = ?').get(orderCode);
  try {
    const guild = await client.guilds.fetch(order.guildId);
    const settings = db.prepare('SELECT feedbackChannelId FROM donation_settings WHERE guildId = ?').get(order.guildId);
    const configuredChannel = settings?.feedbackChannelId
      ? await guild.channels.fetch(settings.feedbackChannelId).catch(() => null)
      : null;
    const channel = configuredChannel?.isTextBased()
      ? configuredChannel
      : guild.channels.cache.find((item) => item.name === gzw.community.feedbackChannelName && item.isTextBased());
    if (!channel) throw new Error(`Không tìm thấy kênh #${gzw.community.feedbackChannelName}`);

    const embed = new EmbedBuilder()
      .setColor(gzw.brandColor)
      .setTitle('💜 Donate đã xác nhận')
      .setDescription(`Người ủng hộ: <@${order.userId}>\nSố tiền: **${new Intl.NumberFormat('vi-VN').format(order.amount)} VND**\nMã đơn: \`${order.transferContent || `${process.env.DONATE_ORDER_PREFIX || 'GZW'}${order.orderCode}`}\`\nMã giao dịch: \`${order.providerReference || 'N/A'}\``)
      .setTimestamp(order.paidAt);
    const message = await channel.send({ embeds: [embed], allowedMentions: { users: [order.userId] } });
    db.prepare(`UPDATE donation_orders SET notificationStatus = 'SENT', notificationMessageId = ?, notifiedAt = ?
      WHERE orderCode = ? AND notificationStatus = 'SENDING'`).run(message.id, Date.now(), orderCode);
    return true;
  } catch (error) {
    db.prepare(`UPDATE donation_orders SET notificationStatus = 'PENDING'
      WHERE orderCode = ? AND notificationStatus = 'SENDING'`).run(orderCode);
    throw error;
  }
}

function reconcileTransaction(tx, client, prefix) {
  const txId = String(tx.id || tx.reference_number || '').trim();
  const amountIn = Math.round(Number(tx.amount_in || 0));
  if (!txId || !Number.isSafeInteger(amountIn) || amountIn <= 0) return null;

  const orderCode = extractOrderCode(tx, prefix);
  const content = String(tx.transaction_content || '').slice(0, 500);
  const transactionDate = String(tx.transaction_date || '').slice(0, 50);
  const reference = String(tx.reference_number || '').slice(0, 120);
  const result = db.transaction(() => {
    const previous = db.prepare('SELECT matchStatus FROM donation_transactions WHERE txId = ?').get(txId);
    if (previous && previous.matchStatus !== 'not_found') return { duplicate: true };

    const order = orderCode && db.prepare('SELECT * FROM donation_orders WHERE orderCode = ?').get(orderCode);
    let matchStatus = 'not_found';
    let paid = false;
    if (order) {
      if (order.status !== 'PENDING') matchStatus = 'not_pending';
      else if (order.amount !== amountIn) matchStatus = 'amount_mismatch';
      else {
        const now = Date.now();
        db.prepare(`UPDATE donation_orders SET status = 'PAID', providerReference = ?, paidAt = ?
          WHERE orderCode = ? AND status = 'PENDING'`).run(txId, now, orderCode);
        matchStatus = 'paid';
        paid = true;
      }
    }

    db.prepare(`INSERT INTO donation_transactions (txId, orderCode, transactionDate, amountIn, content, reference, matchStatus, receivedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (txId) DO UPDATE SET orderCode = excluded.orderCode, matchStatus = excluded.matchStatus`)
      .run(txId, orderCode, transactionDate, amountIn, content, reference, matchStatus, Date.now());
    return { paid, orderCode, matchStatus };
  })();

  if (result.paid) {
    notifyPaidDonation(client, orderCode).catch((error) => {
      console.error(`❌ Chưa gửi được thông báo donate #${orderCode}:`, error.message);
    });
  }
  return result;
}

async function pollOnce(client) {
  const settings = config();
  const transactions = await fetchTransactions(settings);
  const ordered = transactions.slice().sort((a, b) => String(a.transaction_date || '').localeCompare(String(b.transaction_date || '')));
  for (const transaction of ordered) reconcileTransaction(transaction, client, settings.prefix);

  const pending = db.prepare(`SELECT orderCode FROM donation_orders
    WHERE status = 'PAID' AND notificationStatus = 'PENDING' ORDER BY paidAt`).all();
  for (const order of pending) {
    await notifyPaidDonation(client, order.orderCode).catch((error) => {
      console.error(`❌ Chưa gửi được thông báo donate #${order.orderCode}:`, error.message);
    });
  }
}

function startSePayPolling(client) {
  client.once('clientReady', () => {
    const configuredInterval = Number(process.env.SEPAY_POLL_INTERVAL_MS || 60000);
    const interval = Number.isFinite(configuredInterval)
      ? Math.min(3600000, Math.max(15000, configuredInterval))
      : 60000;
    const run = async () => {
      if (polling) return;
      polling = true;
      try {
        await pollOnce(client);
      } catch (error) {
        console.error('❌ Lỗi polling giao dịch SePay:', error.message);
      } finally {
        polling = false;
      }
    };
    run();
    const timer = setInterval(run, interval);
    timer.unref();
    console.log(`✅ SePay transaction polling mỗi ${Math.round(interval / 1000)} giây.`);
  });
}

module.exports = { createDonationOrder, extractOrderCode, pollOnce, reconcileTransaction, startSePayPolling };