const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const gzw = require('../config/gzw');

let running = false;

async function deliverDueCapsules(client) {
  if (running) return;
  running = true;
  try {
    db.prepare(`UPDATE time_capsules SET status = 'pending'
      WHERE status = 'delivering' AND createdAt < ?`).run(Date.now() - 10 * 60000);
    const due = db.prepare(`SELECT * FROM time_capsules
      WHERE status = 'pending' AND deliverAt <= ? ORDER BY deliverAt LIMIT 25`).all(Date.now());

    for (const capsule of due) {
      const claimed = db.prepare(`UPDATE time_capsules SET status = 'delivering'
        WHERE id = ? AND status = 'pending'`).run(capsule.id).changes;
      if (!claimed) continue;
      try {
        const embed = new EmbedBuilder()
          .setColor(gzw.brandColor)
          .setTitle(capsule.audience === 'self' ? '⏳ Hộp thời gian của bạn' : '🌙 Thư gửi từ hộp thời gian')
          .setDescription(capsule.content)
          .setTimestamp(capsule.deliverAt);
        if (capsule.audience === 'self') {
          const user = await client.users.fetch(capsule.userId);
          await user.send({ embeds: [embed] });
        } else {
          const channel = await client.channels.fetch(capsule.channelId);
          if (!channel?.isTextBased()) throw new Error('Kênh nhận hộp thời gian không còn khả dụng');
          await channel.send({ content: `Từ <@${capsule.userId}>`, embeds: [embed], allowedMentions: { users: [capsule.userId] } });
        }
        db.prepare(`UPDATE time_capsules SET status = 'sent', deliveredAt = ? WHERE id = ? AND status = 'delivering'`)
          .run(Date.now(), capsule.id);
      } catch (error) {
        db.prepare(`UPDATE time_capsules SET status = 'failed' WHERE id = ? AND status = 'delivering'`).run(capsule.id);
        console.error(`❌ Không gửi được time capsule #${capsule.id}:`, error.message);
      }
    }
  } finally {
    running = false;
  }
}

function startTimeCapsuleScheduler(client) {
  const tick = () => deliverDueCapsules(client).catch((error) => console.error('❌ Time capsule scheduler:', error.message));
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return timer;
}

module.exports = { deliverDueCapsules, startTimeCapsuleScheduler };