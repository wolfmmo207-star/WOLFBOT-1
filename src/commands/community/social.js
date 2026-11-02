const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType
} = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');

const intents = [
  { name: 'Tình bạn', value: 'friendship' },
  { name: 'Hẹn hò', value: 'dating' },
  { name: 'Cả hai', value: 'both' }
];
const intentLabels = Object.fromEntries(intents.map((item) => [item.value, item.name]));
const talkTopics = [
  { name: 'Ngẫu nhiên', value: 'random' },
  { name: 'Game', value: 'games' },
  { name: 'Anime', value: 'anime' },
  { name: 'Âm nhạc', value: 'music' },
  { name: 'Học tập', value: 'study' },
  { name: 'Phim ảnh', value: 'movies' },
  { name: 'Công nghệ', value: 'technology' }
];
const talkTopicLabels = Object.fromEntries(talkTopics.map((topic) => [topic.value, topic.name]));
const avatarStyleColors = { teal: 0x31a89c, coral: 0xe77875, amber: 0xd79b42, green: 0x4c9a69, blue: 0x5586c8 };

function parseInterests(value) {
  return [...new Set(String(value || '').split(',').map((interest) => interest.trim().toLocaleLowerCase()).filter(Boolean))]
    .slice(0, 10)
    .map((interest) => interest.slice(0, 30));
}

function storedInterests(profile) {
  try {
    const parsed = JSON.parse(profile.interests || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function configuredChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

function profileCard(profile, user, sharedInterests = [], superliked = false, avatarStyle = 'teal') {
  const embed = new EmbedBuilder()
    .setColor(avatarStyleColors[avatarStyle] || gzw.brandColor)
    .setTitle(`🐺 ${user.username}`)
    .setDescription(profile.bio)
    .addFields(
      { name: 'Tuổi', value: String(profile.age), inline: true },
      { name: 'Đang tìm', value: intentLabels[profile.lookingFor], inline: true }
    );
  const interests = storedInterests(profile);
  if (interests.length) embed.addFields({ name: 'Sở thích', value: interests.join(' · ') });
  if (sharedInterests.length) embed.addFields({ name: 'Sở thích chung', value: sharedInterests.join(', ') });
  if (superliked) embed.addFields({ name: '✨ Tín hiệu đặc biệt', value: 'Người này đã siêu thích bạn.' });
  if (user.displayAvatarURL) embed.setImage(user.displayAvatarURL({ size: 512 }));
  return embed;
}

function nextProfile(guildId, userId) {
  return db.prepare(`SELECT p.* FROM dating_profiles p
    WHERE p.guildId = ? AND p.enabled = 1 AND p.age >= 18 AND p.userId != ?
      AND NOT EXISTS (
        SELECT 1 FROM dating_swipes s
        WHERE s.guildId = p.guildId AND s.fromUserId = ? AND s.toUserId = p.userId
      )
    ORDER BY RANDOM() LIMIT 1`).get(guildId, userId, userId);
}

function bestSoulmate(guildId, userId) {
  const self = db.prepare('SELECT * FROM dating_profiles WHERE guildId = ? AND userId = ? AND enabled = 1 AND age >= 18').get(guildId, userId);
  if (!self) return null;
  const ownInterests = new Set(storedInterests(self));
  if (!ownInterests.size) return { needsInterests: true };
  const candidates = db.prepare(`SELECT p.* FROM dating_profiles p
    WHERE p.guildId = ? AND p.enabled = 1 AND p.age >= 18 AND p.userId != ?
      AND NOT EXISTS (
        SELECT 1 FROM dating_swipes s
        WHERE s.guildId = p.guildId AND s.fromUserId = ? AND s.toUserId = p.userId
      )`).all(guildId, userId, userId)
    .map((profile) => ({
      profile,
      shared: storedInterests(profile).filter((interest) => ownInterests.has(interest))
    }))
    .filter((candidate) => candidate.shared.length)
    .sort((left, right) => right.shared.length - left.shared.length);
  return candidates[0] || null;
}

function lastSwipe(guildId, userId) {
  return db.prepare(`SELECT s.toUserId, s.action,
      EXISTS (SELECT 1 FROM dating_matches m WHERE m.guildId = s.guildId
        AND ((m.userA = s.fromUserId AND m.userB = s.toUserId) OR (m.userB = s.fromUserId AND m.userA = s.toUserId))) AS matched
    FROM dating_swipes s WHERE s.guildId = ? AND s.fromUserId = ?
    ORDER BY s.createdAt DESC, s.rowid DESC LIMIT 1`).get(guildId, userId);
}

function undoButton(userId, previous) {
  return new ButtonBuilder()
    .setCustomId(`dating:undo:${previous?.toUserId || userId}`)
    .setLabel('Hoàn tác')
    .setEmoji('↶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!previous || Boolean(previous.matched));
}

function chatButton(guildId, otherUserId) {
  return new ButtonBuilder()
    .setCustomId(`dating:chat:${guildId}:${otherUserId}`)
    .setLabel('Mở chat riêng')
    .setEmoji('💬')
    .setStyle(ButtonStyle.Primary);
}

function chatLinkButton(guildId, threadId) {
  return new ButtonBuilder()
    .setLabel('Mở chat riêng')
    .setEmoji('💬')
    .setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${guildId}/${threadId}`);
}

async function openMatchedChat(interaction, client, guildId, otherUserId) {
  const userId = interaction.user.id;
  const [userA, userB] = [userId, otherUserId].sort();
  const matched = db.prepare('SELECT 1 FROM dating_matches WHERE guildId = ? AND userA = ? AND userB = ?').get(guildId, userA, userB);
  const reply = (content, components = []) => {
    const payload = { content, components };
    if (interaction.guild) payload.ephemeral = true;
    return interaction.reply(payload);
  };
  if (!matched) return reply('Chỉ có thể mở chat sau khi hai bạn đã match.');

  const settings = db.prepare('SELECT tinderChannelId FROM social_settings WHERE guildId = ?').get(guildId);
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const channel = guild && settings ? await configuredChannel(guild, settings.tinderChannelId) : null;
  if (!channel?.threads) return reply('Kênh Tinder chưa được cấu hình hoặc không dùng được private thread.');

  let chat = db.prepare('SELECT * FROM dating_match_chats WHERE guildId = ? AND userA = ? AND userB = ?').get(guildId, userA, userB);
  if (chat?.status === 'active' && chat.threadId) {
    const existingThread = await client.channels.fetch(chat.threadId).catch(() => null);
    if (existingThread?.isThread()) {
      return reply('Cuộc trò chuyện riêng của hai bạn đã sẵn sàng:', [new ActionRowBuilder().addComponents(chatLinkButton(guildId, chat.threadId))]);
    }
    db.prepare("UPDATE dating_match_chats SET status = 'failed', updatedAt = ? WHERE guildId = ? AND userA = ? AND userB = ?")
      .run(Date.now(), guildId, userA, userB);
    chat = null;
  }

  const now = Date.now();
  const claim = db.transaction(() => {
    const current = db.prepare('SELECT * FROM dating_match_chats WHERE guildId = ? AND userA = ? AND userB = ?').get(guildId, userA, userB);
    if (current?.status === 'active') return { state: 'active', threadId: current.threadId };
    if (current?.status === 'creating' && current.updatedAt > now - 5 * 60 * 1000) return { state: 'creating' };
    db.prepare(`INSERT INTO dating_match_chats (guildId, userA, userB, status, createdAt, updatedAt)
      VALUES (?, ?, ?, 'creating', ?, ?)
      ON CONFLICT (guildId, userA, userB) DO UPDATE SET threadId = NULL, status = 'creating', updatedAt = excluded.updatedAt`)
      .run(guildId, userA, userB, now, now);
    return { state: 'claimed' };
  })();
  if (claim.state === 'creating') return reply('Đang tạo chat riêng cho hai bạn, thử lại sau ít giây nhé.');
  if (claim.state === 'active' && claim.threadId) {
    return reply('Cuộc trò chuyện riêng của hai bạn đã sẵn sàng:', [new ActionRowBuilder().addComponents(chatLinkButton(guildId, claim.threadId))]);
  }

  let thread;
  try {
    thread = await channel.threads.create({
      name: `match-${userA.slice(-4)}-${userB.slice(-4)}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 1440,
      invitable: false,
      reason: 'Tạo chat riêng sau khi hai thành viên cùng match'
    });
    await thread.members.add(userA);
    await thread.members.add(userB);
    await thread.send({ content: '💚 Hai bạn đã match và có thể trò chuyện tại đây. Một trong hai có thể dùng `/social chat-close` để đóng chat.', allowedMentions: { parse: [] } });
    db.prepare("UPDATE dating_match_chats SET threadId = ?, status = 'active', updatedAt = ? WHERE guildId = ? AND userA = ? AND userB = ? AND status = 'creating'")
      .run(thread.id, Date.now(), guildId, userA, userB);
    return reply('Đã tạo chat riêng cho hai bạn:', [new ActionRowBuilder().addComponents(chatLinkButton(guildId, thread.id))]);
  } catch (error) {
    if (thread) await thread.delete('Không thể hoàn tất chat riêng sau match').catch(() => {});
    db.prepare("UPDATE dating_match_chats SET status = 'failed', updatedAt = ? WHERE guildId = ? AND userA = ? AND userB = ?")
      .run(Date.now(), guildId, userA, userB);
    console.error('❌ Không thể tạo chat sau match:', error.message);
    return reply('Không thể tạo chat riêng. Bot cần quyền **Create Private Threads**, **Manage Threads** và **Send Messages in Threads**.');
  }
}

async function browsePayload(interaction, client, soulmate = false) {
  const soulmateResult = soulmate ? bestSoulmate(interaction.guild.id, interaction.user.id) : null;
  if (soulmateResult?.needsInterests) return { content: 'Hãy cập nhật sở thích trong `/social profile` trước khi tìm soulmate.', embeds: [], components: [] };
  const previous = lastSwipe(interaction.guild.id, interaction.user.id);
  const undo = undoButton(interaction.user.id, previous);
  const profile = soulmate ? soulmateResult?.profile : nextProfile(interaction.guild.id, interaction.user.id);
  if (!profile) {
    return {
      content: 'Chưa có hồ sơ mới để xem. Bạn vẫn có thể hoàn tác lượt quẹt gần nhất.',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(undo)]
    };
  }

  const user = await client.users.fetch(profile.userId).catch(() => null);
  if (!user) return { content: 'Hồ sơ này không thể tải. Hãy thử khám phá lại sau.', embeds: [], components: [] };

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const superliked = Boolean(db.prepare('SELECT 1 FROM dating_superlikes WHERE guildId = ? AND fromUserId = ? AND toUserId = ?')
    .get(guildId, profile.userId, userId));
  const avatarStyle = db.prepare('SELECT style FROM social_avatar_styles WHERE guildId = ? AND userId = ?')
    .get(guildId, profile.userId)?.style || 'teal';
  const row = new ActionRowBuilder().addComponents(
    undo,
    new ButtonBuilder().setCustomId(`dating:pass:${profile.userId}`).setLabel('Bỏ qua').setEmoji('✕').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dating:superlike:${profile.userId}`).setLabel('Siêu thích').setEmoji('⭐').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dating:like:${profile.userId}`).setLabel('Thích').setEmoji('💚').setStyle(ButtonStyle.Success)
  );
  return { embeds: [profileCard(profile, user, soulmateResult?.shared, superliked, avatarStyle)], components: [row] };
}

function queueRandomTalk(guildId, userId, topic) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  return db.transaction(() => {
    db.prepare('DELETE FROM random_talk_queue WHERE queuedAt < ?').run(cutoff);
    const staleSessions = db.prepare(`SELECT * FROM random_talk_sessions
      WHERE guildId = ? AND status = 'creating' AND createdAt < ?`).all(guildId, Date.now() - 5 * 60 * 1000);
    for (const stale of staleSessions) {
      db.prepare("UPDATE random_talk_sessions SET status = 'failed', endedAt = ? WHERE id = ? AND status = 'creating'").run(Date.now(), stale.id);
      const restore = db.prepare('INSERT OR IGNORE INTO random_talk_queue (guildId, userId, topic, queuedAt) VALUES (?, ?, ?, ?)');
      restore.run(guildId, stale.userA, stale.topic, Date.now());
      restore.run(guildId, stale.userB, stale.topic, Date.now());
    }
    const active = db.prepare(`SELECT id FROM random_talk_sessions
      WHERE guildId = ? AND status IN ('creating', 'active') AND (userA = ? OR userB = ?)`).get(guildId, userId, userId);
    if (active) return { state: 'active' };

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
        .run(guildId, userId, topic, Date.now());
      return { state: 'waiting' };
    }

    const [userA, userB] = [candidate.userId, userId].sort();
    const effectiveTopic = topic === 'random' ? candidate.topic : topic;
    const sessionId = db.prepare(`INSERT INTO random_talk_sessions (guildId, userA, userB, topic, status, createdAt)
      VALUES (?, ?, ?, ?, 'creating', ?)`).run(guildId, userA, userB, effectiveTopic, Date.now()).lastInsertRowid;
    db.prepare('DELETE FROM random_talk_queue WHERE guildId = ? AND userId IN (?, ?)').run(guildId, userA, userB);
    return { state: 'paired', sessionId, userA, userB, topic: effectiveTopic };
  })();
}

function restoreTalkQueue(session) {
  db.transaction(() => {
    db.prepare("UPDATE random_talk_sessions SET status = 'failed', endedAt = ? WHERE id = ? AND status = 'creating'").run(Date.now(), session.sessionId);
    const insert = db.prepare('INSERT OR IGNORE INTO random_talk_queue (guildId, userId, topic, queuedAt) VALUES (?, ?, ?, ?)');
    insert.run(session.guildId, session.userA, session.topic, Date.now());
    insert.run(session.guildId, session.userB, session.topic, Date.now());
  })();
}

async function joinRandomTalk(interaction, client) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const profile = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(guildId, userId);
  if (!profile?.enabled) return interaction.reply({ content: 'Tạo hồ sơ 18+ bằng `/social profile` và bật hồ sơ trước khi vào Random Talk.', ephemeral: true });

  const settings = db.prepare('SELECT tinderChannelId FROM social_settings WHERE guildId = ?').get(guildId);
  if (!settings) return interaction.reply({ content: 'Quản trị viên cần chạy `/setup social` trước.', ephemeral: true });
  if (interaction.channelId !== settings.tinderChannelId) {
    return interaction.reply({ content: `Hãy vào <#${settings.tinderChannelId}> để tham gia Random Talk.`, ephemeral: true });
  }

  const topic = interaction.options.getString('chu-de') || 'random';
  const result = queueRandomTalk(guildId, userId, topic);
  if (result.state === 'active') return interaction.reply({ content: 'Bạn đang có một cuộc trò chuyện Random Talk. Dùng `/social talk leave` để kết thúc.', ephemeral: true });
  if (result.state === 'waiting') return interaction.reply({ content: 'Đã vào hàng chờ. Khi có người cùng chọn chủ đề, bot sẽ mở private thread cho hai bạn.', ephemeral: true });

  const session = { ...result, guildId };
  const channel = await configuredChannel(interaction.guild, settings.tinderChannelId);
  let thread;
  try {
    if (!channel?.threads) throw new Error('Kênh Tinder không hỗ trợ thread');
    thread = await channel.threads.create({
      name: `random-talk-${String(result.sessionId).slice(-6)}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 60,
      invitable: false,
      reason: 'Ghép Random Talk có sự đồng ý của hai thành viên'
    });
    await thread.members.add(result.userA);
    await thread.members.add(result.userB);
    const topicLabel = talkTopicLabels[result.topic] || 'Ngẫu nhiên';
    await thread.send({ content: `👋 Hai bạn đã cùng đồng ý tham gia Random Talk. Chủ đề: **${topicLabel}**. Một trong hai có thể dùng \/social talk leave để kết thúc.`, allowedMentions: { parse: [] } });
    const activated = db.prepare(`UPDATE random_talk_sessions SET threadId = ?, status = 'active'
      WHERE id = ? AND status = 'creating'`).run(thread.id, result.sessionId).changes;
    if (!activated) throw new Error('Phiên trò chuyện đã bị huỷ');
    const otherUserId = result.userA === userId ? result.userB : result.userA;
    const otherUser = await client.users.fetch(otherUserId).catch(() => null);
    await otherUser?.send(`💬 Bạn đã được ghép Random Talk theo chủ đề ${topicLabel}. Vào private thread trong kênh Tinder: <#${thread.id}>`).catch(() => {});
    return interaction.reply({ content: `✅ Đã ghép với <@${otherUserId}>. Cuộc trò chuyện riêng: ${thread}`, ephemeral: true, allowedMentions: { users: [otherUserId] } });
  } catch (error) {
    if (thread) await thread.delete('Không thể hoàn tất ghép Random Talk').catch(() => {});
    restoreTalkQueue(session);
    console.error('❌ Không thể tạo private thread Random Talk:', error.message);
    return interaction.reply({ content: 'Không tạo được cuộc trò chuyện riêng. Bot cần quyền **Create Private Threads**, **Manage Threads** và **Send Messages in Threads**. Hai bạn đã được đưa lại vào hàng chờ.', ephemeral: true });
  }
}

async function leaveRandomTalk(interaction, client) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const removed = db.prepare('DELETE FROM random_talk_queue WHERE guildId = ? AND userId = ?').run(guildId, userId).changes;
  const session = db.prepare(`SELECT * FROM random_talk_sessions
    WHERE guildId = ? AND status = 'active' AND (userA = ? OR userB = ?)`).get(guildId, userId, userId);
  if (!session) return interaction.reply({ content: removed ? '✅ Đã rời hàng chờ Random Talk.' : 'Bạn chưa ở hàng chờ hoặc trong cuộc trò chuyện Random Talk nào.', ephemeral: true });

  db.prepare("UPDATE random_talk_sessions SET status = 'ended', endedAt = ? WHERE id = ? AND status = 'active'").run(Date.now(), session.id);
  const thread = await client.channels.fetch(session.threadId).catch(() => null);
  if (thread?.isThread()) {
    await thread.send({ content: 'Cuộc trò chuyện đã kết thúc theo yêu cầu của một thành viên.', allowedMentions: { parse: [] } }).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  return interaction.reply({ content: '✅ Đã kết thúc Random Talk và đóng private thread.', ephemeral: true });
}

async function closeMatchedChat(interaction) {
  const session = db.prepare(`SELECT * FROM dating_match_chats
    WHERE guildId = ? AND threadId = ? AND status = 'active'
      AND (userA = ? OR userB = ?)`).get(interaction.guild.id, interaction.channelId, interaction.user.id, interaction.user.id);
  if (!session) return interaction.reply({ content: 'Bạn không ở trong chat match đang hoạt động này.', ephemeral: true });

  db.prepare("UPDATE dating_match_chats SET status = 'ended', updatedAt = ? WHERE guildId = ? AND userA = ? AND userB = ? AND status = 'active'")
    .run(Date.now(), session.guildId, session.userA, session.userB);
  await interaction.reply({ content: '✅ Đã đóng chat riêng.', ephemeral: true });
  await interaction.channel.setArchived(true).catch(() => {});
}

module.exports = {
  group: 'Cộng đồng',
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('social')
    .setDescription('Ghép đôi tự nguyện, confession và feedback')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('profile').setDescription('Tạo hoặc cập nhật hồ sơ (chỉ dành cho người từ 18 tuổi)')
      .addIntegerOption((o) => o.setName('tuoi').setDescription('Xác nhận bạn từ 18 tuổi').setRequired(true).setMinValue(18).setMaxValue(99))
      .addStringOption((o) => o.setName('gioi-thieu').setDescription('Giới thiệu ngắn').setRequired(true).setMinLength(10).setMaxLength(300))
      .addStringOption((o) => o.setName('tim-kiem').setDescription('Bạn đang tìm kiếm điều gì?').setRequired(true)
        .addChoices(...intents))
      .addStringOption((o) => o.setName('so-thich').setDescription('Sở thích, phân cách bằng dấu phẩy (tối đa 10)').setMaxLength(200)))
    .addSubcommand((s) => s.setName('discover').setDescription('Xem hồ sơ và chọn thích hoặc bỏ qua'))
    .addSubcommand((s) => s.setName('soulmate').setDescription('Tìm hồ sơ có nhiều sở thích chung nhất'))
    .addSubcommand((s) => s.setName('chat-close').setDescription('Đóng chat riêng sau khi match'))
    .addSubcommandGroup((g) => g.setName('talk').setDescription('Ghép nói chuyện ngẫu nhiên có đồng ý')
      .addSubcommand((s) => s.setName('queue').setDescription('Vào hàng chờ nói chuyện riêng')
        .addStringOption((o) => o.setName('chu-de').setDescription('Ghép theo chủ đề').addChoices(...talkTopics)))
      .addSubcommand((s) => s.setName('leave').setDescription('Rời hàng chờ hoặc kết thúc cuộc nói chuyện')))
    .addSubcommand((s) => s.setName('pause').setDescription('Tạm ẩn hồ sơ ghép đôi'))
    .addSubcommand((s) => s.setName('erase').setDescription('Xoá hồ sơ, lượt quẹt và kết nối ghép đôi'))
    .addSubcommand((s) => s.setName('confession').setDescription('Gửi confession ẩn danh')
      .addStringOption((o) => o.setName('noi-dung').setDescription('Nội dung confession').setRequired(true).setMinLength(5).setMaxLength(1500)))
    .addSubcommand((s) => s.setName('feedback').setDescription('Gửi feedback cho đội ngũ server')
      .addStringOption((o) => o.setName('noi-dung').setDescription('Nội dung feedback').setRequired(true).setMinLength(5).setMaxLength(1500))),

  async execute(interaction, client) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'profile') {
      const age = interaction.options.getInteger('tuoi');
      const bio = interaction.options.getString('gioi-thieu');
      const lookingFor = interaction.options.getString('tim-kiem');
      const interests = JSON.stringify(parseInterests(interaction.options.getString('so-thich')));
      db.prepare(`INSERT INTO dating_profiles (guildId, userId, age, bio, interests, lookingFor, enabled, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT (guildId, userId) DO UPDATE SET
          age = excluded.age, bio = excluded.bio, interests = excluded.interests, lookingFor = excluded.lookingFor,
          enabled = 1, updatedAt = excluded.updatedAt`).run(guildId, userId, age, bio, interests, lookingFor, Date.now());
      return interaction.reply({ content: '✅ Hồ sơ đã bật. Hồ sơ chỉ hiển thị trong server này; sở thích giúp tìm soulmate tương đồng. Tuổi từ 18 trở lên dựa trên xác nhận của bạn.', ephemeral: true });
    }

    if (subcommand === 'discover') {
      const settings = db.prepare('SELECT tinderChannelId FROM social_settings WHERE guildId = ?').get(guildId);
      if (!settings) return interaction.reply({ content: 'Quản trị viên cần chạy `/setup social` trước.', ephemeral: true });
      if (interaction.channelId !== settings.tinderChannelId) {
        const tinderChannel = await configuredChannel(interaction.guild, settings.tinderChannelId);
        const destination = tinderChannel ? `<#${settings.tinderChannelId}>` : 'kênh Tinder đã cấu hình';
        return interaction.reply({ content: `Hãy dùng lệnh khám phá trong ${destination}.`, ephemeral: true });
      }
      const ownProfile = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(guildId, userId);
      if (!ownProfile?.enabled) return interaction.reply({ content: 'Hãy tạo hoặc bật hồ sơ bằng `/social profile` trước khi khám phá.', ephemeral: true });
      return interaction.reply({ ...(await browsePayload(interaction, client)), ephemeral: true });
    }

    if (subcommand === 'soulmate') {
      const settings = db.prepare('SELECT tinderChannelId FROM social_settings WHERE guildId = ?').get(guildId);
      if (!settings) return interaction.reply({ content: 'Quản trị viên cần chạy `/setup social` trước.', ephemeral: true });
      if (interaction.channelId !== settings.tinderChannelId) return interaction.reply({ content: `Hãy dùng lệnh soulmate trong <#${settings.tinderChannelId}>.`, ephemeral: true });
      const ownProfile = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(guildId, userId);
      if (!ownProfile?.enabled) return interaction.reply({ content: 'Hãy tạo hoặc bật hồ sơ bằng `/social profile` trước.', ephemeral: true });
      return interaction.reply({ ...(await browsePayload(interaction, client, true)), ephemeral: true });
    }

    if (subcommand === 'chat-close') return closeMatchedChat(interaction);

    if (interaction.options.getSubcommandGroup() === 'talk') {
      if (interaction.options.getSubcommand() === 'queue') return joinRandomTalk(interaction, client);
      return leaveRandomTalk(interaction, client);
    }

    if (subcommand === 'pause') {
      const changed = db.prepare('UPDATE dating_profiles SET enabled = 0, updatedAt = ? WHERE guildId = ? AND userId = ?').run(Date.now(), guildId, userId).changes;
      return interaction.reply({ content: changed ? '✅ Hồ sơ đã được ẩn.' : 'Bạn chưa có hồ sơ ghép đôi.', ephemeral: true });
    }

    if (subcommand === 'erase') {
      const erase = db.transaction(() => {
        db.prepare('DELETE FROM dating_swipes WHERE guildId = ? AND (fromUserId = ? OR toUserId = ?)').run(guildId, userId, userId);
        db.prepare('DELETE FROM dating_superlikes WHERE guildId = ? AND (fromUserId = ? OR toUserId = ?)').run(guildId, userId, userId);
        db.prepare('DELETE FROM dating_matches WHERE guildId = ? AND (userA = ? OR userB = ?)').run(guildId, userId, userId);
        return db.prepare('DELETE FROM dating_profiles WHERE guildId = ? AND userId = ?').run(guildId, userId).changes;
      });
      const changed = erase();
      return interaction.reply({ content: changed ? '✅ Hồ sơ, lượt quẹt và kết nối của bạn đã được xoá.' : 'Bạn chưa có hồ sơ ghép đôi.', ephemeral: true });
    }

    if (subcommand === 'confession' || subcommand === 'feedback') {
      const isConfession = subcommand === 'confession';
      const channelName = isConfession ? gzw.community.confessionChannelName : gzw.community.feedbackChannelName;
      const settings = isConfession
        ? db.prepare('SELECT confessionChannelId FROM social_settings WHERE guildId = ?').get(guildId)
        : null;
      if (isConfession && !settings) {
        return interaction.reply({ content: 'Quản trị viên cần chạy `/setup social` trước khi nhận confession.', ephemeral: true });
      }
      const channel = isConfession
        ? await configuredChannel(interaction.guild, settings.confessionChannelId)
        : interaction.guild.channels.cache.find((item) => item.name === channelName && item.isTextBased());
      if (!channel) return interaction.reply({ content: `Chưa tìm thấy kênh #${channelName}. Hãy tạo kênh này hoặc chỉnh cấu hình cộng đồng.`, ephemeral: true });

      const content = interaction.options.getString('noi-dung');
      const embed = new EmbedBuilder()
        .setColor(gzw.brandColor)
        .setTitle(isConfession ? '🕊️ Confession' : '📝 Feedback')
        .setDescription(content)
        .setTimestamp();
      if (!isConfession) embed.setFooter({ text: `Gửi bởi ${interaction.user.username} (${userId})` });

      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return interaction.reply({ content: isConfession ? '✅ Confession đã được gửi ẩn danh.' : '✅ Feedback đã được gửi tới đội ngũ server.', ephemeral: true });
    }
  },

  async handleButton(interaction, client) {
    const [, action, targetId] = interaction.customId.split(':');
    if (action === 'chat') {
      const [, , guildId, otherUserId] = interaction.customId.split(':');
      if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(otherUserId) || otherUserId === interaction.user.id) {
        return interaction.reply({ content: 'Nút chat không hợp lệ.', ephemeral: Boolean(interaction.guild) });
      }
      return openMatchedChat(interaction, client, guildId, otherUserId);
    }
    if (!['undo', 'like', 'pass', 'superlike'].includes(action) || !/^\d{17,20}$/.test(targetId) || targetId === interaction.user.id) {
      return interaction.reply({ content: 'Lựa chọn này không hợp lệ.', ephemeral: true });
    }

    if (action === 'undo') {
      const last = db.prepare(`SELECT toUserId FROM dating_swipes WHERE guildId = ? AND fromUserId = ?
        ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(interaction.guild.id, interaction.user.id);
      if (!last || last.toUserId !== targetId) return interaction.reply({ content: 'Không thể hoàn tác lượt quẹt này.', ephemeral: true });
      const [userA, userB] = [interaction.user.id, targetId].sort();
      const matched = db.prepare('SELECT 1 FROM dating_matches WHERE guildId = ? AND userA = ? AND userB = ?').get(interaction.guild.id, userA, userB);
      if (matched) return interaction.reply({ content: 'Không thể hoàn tác sau khi đã ghép đôi.', ephemeral: true });
      db.transaction(() => {
        db.prepare('DELETE FROM dating_swipes WHERE guildId = ? AND fromUserId = ? AND toUserId = ?').run(interaction.guild.id, interaction.user.id, targetId);
        db.prepare('DELETE FROM dating_superlikes WHERE guildId = ? AND fromUserId = ? AND toUserId = ?').run(interaction.guild.id, interaction.user.id, targetId);
      })();
      return interaction.update(await browsePayload(interaction, client));
    }

    const target = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(interaction.guild.id, targetId);
    if (!target?.enabled) return interaction.update({ content: 'Hồ sơ này không còn khả dụng.', embeds: [], components: [] });

    const swipe = db.prepare('INSERT OR IGNORE INTO dating_swipes (guildId, fromUserId, toUserId, action, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(interaction.guild.id, interaction.user.id, targetId, action === 'pass' ? 'pass' : 'like', Date.now());
    if (!swipe.changes) return interaction.update(await browsePayload(interaction, client));
    if (action === 'superlike') {
      db.prepare('INSERT OR IGNORE INTO dating_superlikes (guildId, fromUserId, toUserId, createdAt) VALUES (?, ?, ?, ?)')
        .run(interaction.guild.id, interaction.user.id, targetId, Date.now());
    }

    let matched = false;
    if (action === 'like' || action === 'superlike') {
      const reciprocal = db.prepare("SELECT 1 FROM dating_swipes WHERE guildId = ? AND fromUserId = ? AND toUserId = ? AND action = 'like'")
        .get(interaction.guild.id, targetId, interaction.user.id);
      if (reciprocal) {
        const [userA, userB] = [interaction.user.id, targetId].sort();
        matched = db.prepare('INSERT OR IGNORE INTO dating_matches (guildId, userA, userB, createdAt) VALUES (?, ?, ?, ?)')
          .run(interaction.guild.id, userA, userB, Date.now()).changes > 0;
      }
    }

    if (matched) {
      const other = await client.users.fetch(targetId).catch(() => null);
      const rowForOther = new ActionRowBuilder().addComponents(chatButton(interaction.guild.id, interaction.user.id));
      const rowForCurrent = new ActionRowBuilder().addComponents(chatButton(interaction.guild.id, targetId));
      await interaction.user.send({ content: `💚 Bạn và **${other?.username || 'một thành viên'}** đã match! Bấm nút để mở chat riêng.`, components: [rowForCurrent] }).catch(() => {});
      await other?.send({ content: `💚 Bạn và **${interaction.user.username}** đã match! Bấm nút để mở chat riêng.`, components: [rowForOther] }).catch(() => {});
    }

    const payload = await browsePayload(interaction, client);
    if (matched) {
      payload.content = '💚 Ghép đôi thành công! ' + (payload.content || '');
      payload.components = [...(payload.components || []), new ActionRowBuilder().addComponents(chatButton(interaction.guild.id, targetId))];
    }
    else if (action === 'superlike') payload.content = '⭐ Đã gửi siêu thích. ' + (payload.content || '');
    else if (action === 'like') payload.content = 'Đã gửi lượt thích. ' + (payload.content || '');
    return interaction.update(payload);
  }
};