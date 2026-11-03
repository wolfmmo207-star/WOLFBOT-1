const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType
} = require('discord.js');
const db = require('../database/db');
const gzw = require('../config/gzw');

const topics = [
  { name: 'Ngẫu nhiên', value: 'random' },
  { name: 'Game', value: 'games' },
  { name: 'Anime', value: 'anime' },
  { name: 'Âm nhạc', value: 'music' },
  { name: 'Học tập', value: 'study' },
  { name: 'Phim ảnh', value: 'movies' },
  { name: 'Công nghệ', value: 'technology' }
];
const topicLabels = Object.fromEntries(topics.map((topic) => [topic.value, topic.name]));
const prompts = [
  'Kể về một sở thích bạn muốn thử trong năm nay.',
  'Chọn một bài hát có thể bật lại nhiều lần và nói vì sao.',
  'Nếu có một ngày rảnh hoàn toàn, bạn sẽ làm gì?',
  'Kể về một trò chơi, bộ phim hoặc cuốn sách bạn muốn giới thiệu.',
  'Cùng nghĩ ra một kế hoạch vui cho cuối tuần.'
];

function randomTalkPanel() {
  const embed = new EmbedBuilder()
    .setColor(gzw.brandColor)
    .setTitle('🗣️ Random Talk')
    .setDescription('Chọn chủ đề rồi bấm **Tìm người**. Bot chỉ ghép hai người cùng opt-in và mở private thread. Bấm **Hủy tìm** để rời hàng chờ.');
  const topicRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('randomtalk:topic').setPlaceholder('Chọn chủ đề trò chuyện')
      .addOptions(topics.map((topic) => ({ label: topic.name, value: topic.value })))
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('randomtalk:find').setLabel('Tìm người').setEmoji('🔎').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('randomtalk:cancel').setLabel('Hủy tìm').setEmoji('⏹️').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [topicRow, buttons], allowedMentions: { parse: [] } };
}

async function postRandomTalkPanel(guild, channel) {
  const settings = db.prepare('SELECT panelMessageId FROM random_talk_settings WHERE guildId = ?').get(guild.id);
  const oldMessage = settings?.panelMessageId ? await channel.messages.fetch(settings.panelMessageId).catch(() => null) : null;
  const panel = oldMessage
    ? await oldMessage.edit(randomTalkPanel())
    : await channel.send(randomTalkPanel());
  db.prepare('UPDATE random_talk_settings SET panelMessageId = ?, updatedAt = ? WHERE guildId = ?')
    .run(panel.id, Date.now(), guild.id);
  return panel;
}

function joinQueue(guildId, userId, topic) {
  const now = Date.now();
  return db.transaction(() => {
    db.prepare('DELETE FROM random_talk_queue WHERE queuedAt < ?').run(now - 15 * 60000);
    const stale = db.prepare(`SELECT * FROM random_talk_sessions
      WHERE guildId = ? AND status = 'creating' AND createdAt < ?`).all(guildId, now - 5 * 60000);
    for (const session of stale) {
      db.prepare("UPDATE random_talk_sessions SET status = 'failed', endedAt = ? WHERE id = ? AND status = 'creating'").run(now, session.id);
      const restore = db.prepare('INSERT OR IGNORE INTO random_talk_queue (guildId, userId, topic, queuedAt) VALUES (?, ?, ?, ?)');
      restore.run(guildId, session.userA, session.topic, now);
      restore.run(guildId, session.userB, session.topic, now);
    }
    const active = db.prepare(`SELECT s.id FROM random_talk_sessions s
      WHERE s.guildId = ? AND s.status IN ('creating', 'active') AND (s.userA = ? OR s.userB = ?)`).get(guildId, userId, userId);
    if (active) return { state: 'active' };

    db.prepare(`INSERT INTO random_talk_preferences (guildId, userId, topic, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT (guildId, userId) DO UPDATE SET topic = excluded.topic, updatedAt = excluded.updatedAt`)
      .run(guildId, userId, topic, now);
    const candidate = db.prepare(`SELECT q.* FROM random_talk_queue q
      JOIN dating_profiles p ON p.guildId = q.guildId AND p.userId = q.userId AND p.enabled = 1 AND p.age >= 18
      WHERE q.guildId = ? AND q.userId != ? AND (q.topic = 'random' OR ? = 'random' OR q.topic = ?)
        AND NOT EXISTS (
          SELECT 1 FROM random_talk_sessions s
          WHERE s.guildId = q.guildId AND s.status IN ('creating', 'active') AND (s.userA = q.userId OR s.userB = q.userId)
        )
      ORDER BY q.queuedAt LIMIT 1`).get(guildId, userId, topic, topic);
    if (!candidate) {
      db.prepare(`INSERT INTO random_talk_queue (guildId, userId, topic, queuedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT (guildId, userId) DO UPDATE SET topic = excluded.topic, queuedAt = excluded.queuedAt`)
        .run(guildId, userId, topic, now);
      return { state: 'waiting' };
    }

    const [userA, userB] = [candidate.userId, userId].sort();
    const selectedTopic = topic === 'random' ? candidate.topic : topic;
    const sessionId = db.prepare(`INSERT INTO random_talk_sessions (guildId, userA, userB, topic, status, createdAt)
      VALUES (?, ?, ?, ?, 'creating', ?)`).run(guildId, userA, userB, selectedTopic, now).lastInsertRowid;
    db.prepare('DELETE FROM random_talk_queue WHERE guildId = ? AND userId IN (?, ?)').run(guildId, userA, userB);
    return { state: 'paired', sessionId, userA, userB, topic: selectedTopic };
  })();
}

async function findPartner(interaction, client) {
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;
  const profile = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(guildId, userId);
  if (!profile?.enabled) return interaction.reply({ content: 'Bật profile 18+ bằng `/social profile` trước khi vào Random Talk.', ephemeral: true });
  const settings = db.prepare('SELECT channelId FROM random_talk_settings WHERE guildId = ?').get(guildId);
  if (!settings) return interaction.reply({ content: 'Quản trị viên cần chạy `/setup random-talk` trước.', ephemeral: true });
  if (interaction.channelId !== settings.channelId) return interaction.reply({ content: `Dùng bảng Random Talk trong <#${settings.channelId}>.`, ephemeral: true });

  const preference = db.prepare('SELECT topic FROM random_talk_preferences WHERE guildId = ? AND userId = ?').get(guildId, userId);
  const topic = preference?.topic || 'random';
  const result = joinQueue(guildId, userId, topic);
  if (result.state === 'active') return interaction.reply({ content: 'Bạn đang có một phiên Random Talk. Dùng nút kết thúc trong thread hiện tại.', ephemeral: true });
  if (result.state === 'waiting') return interaction.reply({ content: `🔎 Đã vào hàng chờ chủ đề **${topicLabels[topic] || 'Ngẫu nhiên'}**. Sẽ ghép khi có người cùng opt-in.`, ephemeral: true });

  const settingsAgain = db.prepare('SELECT channelId FROM random_talk_settings WHERE guildId = ?').get(guildId);
  const channel = settingsAgain ? await interaction.guild.channels.fetch(settingsAgain.channelId).catch(() => null) : null;
  let thread;
  try {
    if (!channel?.threads) throw new Error('Random Talk channel does not support threads');
    thread = await channel.threads.create({
      name: `random-talk-${String(result.sessionId).slice(-6)}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 60,
      invitable: false,
      reason: 'Ghép Random Talk có sự đồng ý của hai thành viên'
    });
    await thread.members.add(result.userA);
    await thread.members.add(result.userB);
    const questions = prompts.map((prompt, index) => `**${index + 1}.** ${prompt}`).join('\n');
    const finishButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`randomtalk:finish:${result.sessionId}`).setLabel('Kết thúc chat').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ content: `👋 Random Talk · **${topicLabels[result.topic] || 'Ngẫu nhiên'}**\n${questions}`, components: [finishButton], allowedMentions: { parse: [] } });
    db.prepare("UPDATE random_talk_sessions SET threadId = ?, status = 'active' WHERE id = ? AND status = 'creating'")
      .run(thread.id, result.sessionId);
    const otherId = result.userA === userId ? result.userB : result.userA;
    await client.users.fetch(otherId).then((user) => user.send(`💬 Bạn đã được ghép Random Talk. Vào private thread trong channel Random Talk: <#${thread.id}>`)).catch(() => {});
    return interaction.reply({ content: `✅ Đã ghép với <@${otherId}>. Vào private chat: ${thread}`, ephemeral: true, allowedMentions: { users: [otherId] } });
  } catch (error) {
    if (thread) await thread.delete('Không thể hoàn tất Random Talk').catch(() => {});
    db.transaction(() => {
      db.prepare("UPDATE random_talk_sessions SET status = 'failed', endedAt = ? WHERE id = ? AND status = 'creating'").run(Date.now(), result.sessionId);
      const restore = db.prepare('INSERT OR IGNORE INTO random_talk_queue (guildId, userId, topic, queuedAt) VALUES (?, ?, ?, ?)');
      restore.run(guildId, result.userA, result.topic, Date.now());
      restore.run(guildId, result.userB, result.topic, Date.now());
    })();
    console.error('❌ Không thể tạo Random Talk private thread:', error.message);
    return interaction.reply({ content: 'Không tạo được private chat. Cần cấp bot quyền Create Private Threads, Manage Threads và Send Messages in Threads.', ephemeral: true });
  }
}

async function finishTalk(interaction, client, sessionId) {
  const active = db.prepare(`SELECT * FROM random_talk_sessions
    WHERE id = ? AND guildId = ? AND threadId = ? AND status = 'active' AND (userA = ? OR userB = ?)`)
    .get(sessionId, interaction.guild.id, interaction.channelId, interaction.user.id, interaction.user.id);
  if (!active) return interaction.reply({ content: 'Chỉ thành viên của phiên Random Talk mới được kết thúc.', ephemeral: true });
  db.prepare("UPDATE random_talk_sessions SET status = 'ended', endedAt = ? WHERE id = ? AND status = 'active'")
    .run(Date.now(), active.id);
  await interaction.reply({ content: '✅ Đã kết thúc Random Talk.', ephemeral: true });
  await interaction.channel.setArchived(true).catch(() => {});
  return true;
}

async function handleInteraction(interaction, client) {
  if (interaction.isStringSelectMenu() && interaction.customId === 'randomtalk:topic') {
    const settings = db.prepare('SELECT channelId FROM random_talk_settings WHERE guildId = ?').get(interaction.guild.id);
    if (!settings || settings.channelId !== interaction.channelId) {
      return interaction.reply({ content: 'Bảng Random Talk này không còn được cấu hình.', ephemeral: true });
    }
    const topic = interaction.values[0];
    db.prepare(`INSERT INTO random_talk_preferences (guildId, userId, topic, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT (guildId, userId) DO UPDATE SET topic = excluded.topic, updatedAt = excluded.updatedAt`)
      .run(interaction.guild.id, interaction.user.id, topic, Date.now());
    db.prepare('UPDATE random_talk_queue SET topic = ?, queuedAt = ? WHERE guildId = ? AND userId = ?')
      .run(topic, Date.now(), interaction.guild.id, interaction.user.id);
    return interaction.reply({ content: `✅ Chủ đề đã chọn: **${topicLabels[topic] || 'Ngẫu nhiên'}**. Bấm Tìm người trên bảng để vào queue.`, ephemeral: true });
  }
  if (!interaction.isButton() || !interaction.customId.startsWith('randomtalk:')) return false;
  const [, action, value] = interaction.customId.split(':');
  if (action === 'find') return findPartner(interaction, client);
  if (action === 'cancel') {
    const removed = db.prepare('DELETE FROM random_talk_queue WHERE guildId = ? AND userId = ?').run(interaction.guild.id, interaction.user.id).changes;
    return interaction.reply({ content: removed ? '✅ Đã rời hàng chờ Random Talk.' : 'Bạn hiện không ở trong hàng chờ.', ephemeral: true });
  }
  if (action === 'finish') return finishTalk(interaction, client, Number(value));
  return false;
}

module.exports = { handleInteraction, postRandomTalkPanel };