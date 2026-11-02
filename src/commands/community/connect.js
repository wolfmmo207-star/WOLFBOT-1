const {
  SlashCommandBuilder, EmbedBuilder, ChannelType
} = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');

const topics = [
  { name: 'Âm nhạc', value: 'music' },
  { name: 'Game', value: 'games' },
  { name: 'Anime', value: 'anime' },
  { name: 'Học tập', value: 'study' },
  { name: 'Công nghệ', value: 'technology' },
  { name: 'Phim ảnh', value: 'movies' },
  { name: 'Sách', value: 'books' },
  { name: 'Khác', value: 'other' }
];
const topicLabels = Object.fromEntries(topics.map((topic) => [topic.value, topic.name]));
const questPrompts = [
  'Kể về một sở thích bạn muốn thử trong năm nay.',
  'Chọn một bài hát có thể bật lại nhiều lần và nói vì sao.',
  'Nếu có một ngày rảnh hoàn toàn, bạn sẽ làm gì?',
  'Kể về một trò chơi, bộ phim hoặc cuốn sách bạn muốn giới thiệu.',
  'Cùng nghĩ ra tên nhóm và một kế hoạch vui cho cuối tuần.'
];
const capsuleDelays = [
  { name: '1 tháng', value: 30 },
  { name: '6 tháng', value: 180 },
  { name: '1 năm', value: 365 }
];

async function tinderChannel(guildId, client) {
  const settings = db.prepare('SELECT tinderChannelId FROM social_settings WHERE guildId = ?').get(guildId);
  if (!settings) return null;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  return guild.channels.cache.get(settings.tinderChannelId)
    || await guild.channels.fetch(settings.tinderChannelId).catch(() => null);
}

async function sendAdmirer(interaction, client) {
  const recipient = interaction.options.getUser('nguoi-nhan');
  const compliment = interaction.options.getString('loi-khen').trim();
  if (recipient.id === interaction.user.id) return interaction.reply({ content: 'Hãy chọn một thành viên khác.', ephemeral: true });
  if (!await interaction.guild.members.fetch(recipient.id).catch(() => null)) {
    return interaction.reply({ content: 'Người nhận không còn ở server này.', ephemeral: true });
  }
  const since = Date.now() - 86400000;
  const sentToday = db.prepare('SELECT COUNT(*) AS count FROM secret_admirers WHERE guildId = ? AND senderId = ? AND createdAt >= ?')
    .get(interaction.guild.id, interaction.user.id, since).count;
  if (sentToday >= 3) return interaction.reply({ content: 'Bạn đã dùng hết 3 lời khen ẩn danh trong hôm nay.', ephemeral: true });

  const result = db.prepare(`INSERT INTO secret_admirers (guildId, senderId, recipientId, compliment, createdAt)
    VALUES (?, ?, ?, ?, ?)`).run(interaction.guild.id, interaction.user.id, recipient.id, compliment, Date.now());
  const dm = await recipient.send('💌 Bạn có một lời khen ẩn danh. Dùng `/connect admirer inbox` để đọc và `/connect admirer reply` nếu muốn phản hồi.')
    .then(() => true).catch(() => false);
  return interaction.reply({
    content: `✅ Đã gửi lời khen ẩn danh #${result.lastInsertRowid}.${dm ? '' : ' Người nhận có thể dùng `/connect admirer inbox` nếu chưa nhận được DM.'}`,
    ephemeral: true
  });
}

function admirerInbox(interaction) {
  const rows = db.prepare(`SELECT id, compliment, createdAt FROM secret_admirers
    WHERE guildId = ? AND recipientId = ? AND status IN ('unread', 'read')
    ORDER BY createdAt DESC LIMIT 5`).all(interaction.guild.id, interaction.user.id);
  if (!rows.length) return interaction.reply({ content: 'Bạn chưa có lời khen ẩn danh nào đang chờ.', ephemeral: true });
  db.prepare("UPDATE secret_admirers SET status = 'read' WHERE guildId = ? AND recipientId = ? AND status = 'unread'")
    .run(interaction.guild.id, interaction.user.id);
  const embed = new EmbedBuilder().setColor(gzw.brandColor).setTitle('💌 Lời khen ẩn danh');
  for (const row of rows) embed.addFields({ name: `#${row.id}`, value: `${row.compliment}\nPhản hồi: /connect admirer reply id:${row.id} loi-nhan:<nội dung>` });
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

async function replyAdmirer(interaction, client) {
  const id = interaction.options.getInteger('id');
  const text = interaction.options.getString('loi-nhan').trim();
  const record = db.prepare(`SELECT * FROM secret_admirers WHERE id = ? AND guildId = ? AND recipientId = ?
    AND status IN ('unread', 'read')`).get(id, interaction.guild.id, interaction.user.id);
  if (!record) return interaction.reply({ content: 'Không tìm thấy lời khen hoặc lời khen này đã được phản hồi.', ephemeral: true });
  db.prepare("UPDATE secret_admirers SET reply = ?, status = 'replied', repliedAt = ? WHERE id = ? AND status IN ('unread', 'read')")
    .run(text, Date.now(), id);
  const sender = await client.users.fetch(record.senderId).catch(() => null);
  const delivered = await sender?.send(`💌 Người nhận lời khen #${id} đã phản hồi ẩn danh:\n> ${text}`).then(() => true).catch(() => false);
  return interaction.reply({ content: delivered ? '✅ Đã chuyển phản hồi ẩn danh.' : 'Đã lưu phản hồi, nhưng người gửi hiện không nhận được DM.', ephemeral: true });
}

function joinQuestQueue(guildId, userId) {
  const now = Date.now();
  return db.transaction(() => {
    db.prepare('DELETE FROM friendship_quest_queue WHERE queuedAt < ?').run(now - 30 * 60000);
    const active = db.prepare(`SELECT s.id FROM friendship_quest_sessions s
      JOIN friendship_quest_members m ON m.sessionId = s.id
      WHERE s.guildId = ? AND s.status IN ('creating', 'active') AND m.userId = ?`).get(guildId, userId);
    if (active) return { state: 'active' };
    db.prepare('INSERT OR IGNORE INTO friendship_quest_queue (guildId, userId, queuedAt) VALUES (?, ?, ?)').run(guildId, userId, now);
    const members = db.prepare('SELECT userId FROM friendship_quest_queue WHERE guildId = ? ORDER BY queuedAt LIMIT 3').all(guildId);
    if (members.length < 3) return { state: 'waiting', count: members.length };
    const sessionId = db.prepare(`INSERT INTO friendship_quest_sessions (guildId, status, createdAt) VALUES (?, 'creating', ?)`).run(guildId, now).lastInsertRowid;
    const addMember = db.prepare('INSERT INTO friendship_quest_members (sessionId, guildId, userId) VALUES (?, ?, ?)');
    for (const member of members) addMember.run(sessionId, guildId, member.userId);
    db.prepare('DELETE FROM friendship_quest_queue WHERE guildId = ? AND userId IN (?, ?, ?)')
      .run(guildId, members[0].userId, members[1].userId, members[2].userId);
    return { state: 'paired', sessionId, members: members.map((member) => member.userId) };
  })();
}

async function joinQuest(interaction, client) {
  const channel = await tinderChannel(interaction.guild.id, client);
  if (!channel?.threads || interaction.channelId !== channel.id) {
    return interaction.reply({ content: `Hãy tham gia Friendship Quest trong kênh Tinder đã cấu hình${channel ? `: <#${channel.id}>` : ''}.`, ephemeral: true });
  }
  const result = joinQuestQueue(interaction.guild.id, interaction.user.id);
  if (result.state === 'active') return interaction.reply({ content: 'Bạn đã ở trong một Friendship Quest đang hoạt động.', ephemeral: true });
  if (result.state === 'waiting') return interaction.reply({ content: `Đã vào hàng chờ (${result.count}/3). Bot sẽ mở private thread khi đủ 3 người.`, ephemeral: true });

  let thread;
  try {
    thread = await channel.threads.create({
      name: `friendship-quest-${result.sessionId}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 1440,
      invitable: false,
      reason: 'Nhóm Friendship Quest tự nguyện'
    });
    for (const userId of result.members) await thread.members.add(userId);
    const prompts = questPrompts.map((prompt, index) => `**${index + 1}.** ${prompt}`).join('\n');
    await thread.send({ content: `🤝 **Friendship Quest · nhóm 3**\nMỗi người cùng trả lời 5 câu hỏi:\n${prompts}\n\nDùng /connect quest finish trong thread để kết thúc.`, allowedMentions: { parse: [] } });
    db.prepare("UPDATE friendship_quest_sessions SET threadId = ?, status = 'active' WHERE id = ? AND status = 'creating'")
      .run(thread.id, result.sessionId);
    return interaction.reply({ content: `✅ Đã ghép nhóm! Vào private thread: ${thread}`, ephemeral: true, allowedMentions: { parse: [] } });
  } catch (error) {
    if (thread) await thread.delete('Friendship Quest setup failed').catch(() => {});
    db.transaction(() => {
      db.prepare("UPDATE friendship_quest_sessions SET status = 'failed', endedAt = ? WHERE id = ? AND status = 'creating'").run(Date.now(), result.sessionId);
      const restore = db.prepare('INSERT OR IGNORE INTO friendship_quest_queue (guildId, userId, queuedAt) VALUES (?, ?, ?)');
      for (const userId of result.members) restore.run(interaction.guild.id, userId, Date.now());
    })();
    console.error('❌ Không thể tạo Friendship Quest thread:', error.message);
    return interaction.reply({ content: 'Không tạo được private thread. Bot cần quyền Create Private Threads, Manage Threads và Send Messages in Threads.', ephemeral: true });
  }
}

async function finishQuest(interaction, client) {
  const session = db.prepare(`SELECT s.* FROM friendship_quest_sessions s
    JOIN friendship_quest_members m ON m.sessionId = s.id
    WHERE s.guildId = ? AND s.threadId = ? AND s.status = 'active' AND m.userId = ?`)
    .get(interaction.guild.id, interaction.channelId, interaction.user.id);
  if (!session) return interaction.reply({ content: 'Bạn không ở trong Friendship Quest đang hoạt động này.', ephemeral: true });
  db.prepare("UPDATE friendship_quest_sessions SET status = 'ended', endedAt = ? WHERE id = ? AND status = 'active'")
    .run(Date.now(), session.id);
  await interaction.reply({ content: '✅ Đã kết thúc Friendship Quest.', ephemeral: true });
  const thread = await client.channels.fetch(session.threadId).catch(() => null);
  await thread?.setArchived(true).catch(() => {});
}

function makeClubKey(name) {
  return name.normalize('NFKC').trim().toLocaleLowerCase();
}

async function createClub(interaction, client) {
  const channel = await tinderChannel(interaction.guild.id, client);
  if (!channel?.isTextBased()) return interaction.reply({ content: 'Quản trị viên cần chạy `/setup social` trước.', ephemeral: true });
  const name = interaction.options.getString('ten').trim();
  const topic = interaction.options.getString('chu-de');
  const description = interaction.options.getString('mo-ta').trim();
  const key = makeClubKey(name);
  const clubLimit = db.prepare('SELECT COUNT(*) AS count FROM community_clubs WHERE guildId = ?').get(interaction.guild.id).count;
  if (clubLimit >= 50) return interaction.reply({ content: 'Server đã đạt giới hạn 50 DIS Clubs.', ephemeral: true });

  let clubId;
  try {
    const result = db.transaction(() => {
      const id = db.prepare(`INSERT INTO community_clubs (guildId, name, nameKey, topic, description, createdBy, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(interaction.guild.id, name, key, topic, description, interaction.user.id, Date.now()).lastInsertRowid;
      db.prepare('INSERT INTO community_club_members (clubId, userId, joinedAt) VALUES (?, ?, ?)').run(id, interaction.user.id, Date.now());
      return id;
    })();
    clubId = result;
  } catch {
    return interaction.reply({ content: 'Tên câu lạc bộ này đã được dùng trong server.', ephemeral: true });
  }

  let anchor;
  try {
    const embed = new EmbedBuilder().setColor(gzw.brandColor).setTitle(`🏠 ${name}`)
      .setDescription(description).addFields({ name: 'Chủ đề', value: topicLabels[topic] || 'Khác' })
      .setFooter({ text: `DIS Club #${clubId} · Dùng /connect club join để tham gia` });
    anchor = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    const thread = await anchor.startThread({ name: name.slice(0, 100), autoArchiveDuration: 1440, reason: 'Tạo DIS Club' });
    await thread.members.add(interaction.user.id);
    db.prepare('UPDATE community_clubs SET threadId = ? WHERE id = ?').run(thread.id, clubId);
    return interaction.reply({ content: `✅ Đã tạo **${name}** và mở câu lạc bộ tại ${thread}.`, ephemeral: true });
  } catch (error) {
    if (anchor) await anchor.delete().catch(() => {});
    db.transaction(() => {
      db.prepare('DELETE FROM community_club_members WHERE clubId = ?').run(clubId);
      db.prepare('DELETE FROM community_clubs WHERE id = ?').run(clubId);
    })();
    console.error('❌ Không tạo được DIS Club thread:', error.message);
    return interaction.reply({ content: 'Không tạo được club thread. Bot cần quyền gửi tin và tạo public thread trong kênh Tinder.', ephemeral: true });
  }
}

async function joinClub(interaction, joining) {
  const clubId = interaction.options.getInteger('id');
  const club = db.prepare('SELECT * FROM community_clubs WHERE guildId = ? AND id = ?').get(interaction.guild.id, clubId);
  if (!club) return interaction.reply({ content: 'Không tìm thấy club này trong server.', ephemeral: true });
  if (joining) {
    if (db.prepare('SELECT 1 FROM community_club_members WHERE clubId = ? AND userId = ?').get(clubId, interaction.user.id)) {
      return interaction.reply({ content: 'Bạn đã ở trong club này rồi.', ephemeral: true });
    }
    const thread = club.threadId ? await interaction.guild.channels.fetch(club.threadId).catch(() => null) : null;
    if (!thread?.isThread()) return interaction.reply({ content: 'Club thread không còn khả dụng.', ephemeral: true });
    try {
      await thread.members.add(interaction.user.id);
    } catch {
      return interaction.reply({ content: 'Bot cần quyền **Manage Threads** để thêm bạn vào club.', ephemeral: true });
    }
    db.prepare('INSERT INTO community_club_members (clubId, userId, joinedAt) VALUES (?, ?, ?)').run(clubId, interaction.user.id, Date.now());
    return interaction.reply({ content: `✅ Đã tham gia **${club.name}**: ${thread}`, ephemeral: true });
  }

  const deleted = db.prepare('DELETE FROM community_club_members WHERE clubId = ? AND userId = ?').run(clubId, interaction.user.id).changes;
  if (!deleted) return interaction.reply({ content: 'Bạn chưa tham gia club này.', ephemeral: true });
  const thread = club.threadId ? await interaction.guild.channels.fetch(club.threadId).catch(() => null) : null;
  await thread?.members.remove(interaction.user.id).catch(() => {});
  return interaction.reply({ content: `✅ Đã rời **${club.name}**.`, ephemeral: true });
}

async function listClubs(interaction) {
  const rows = db.prepare(`SELECT c.*, COUNT(m.userId) AS members FROM community_clubs c
    LEFT JOIN community_club_members m ON m.clubId = c.id
    WHERE c.guildId = ? GROUP BY c.id ORDER BY members DESC, c.name COLLATE NOCASE LIMIT 10`).all(interaction.guild.id);
  if (!rows.length) return interaction.reply({ content: 'Chưa có DIS Club. Dùng `/connect club create` để mở câu lạc bộ đầu tiên.', ephemeral: true });
  const embed = new EmbedBuilder().setColor(gzw.brandColor).setTitle('🏠 DIS Clubs');
  for (const club of rows) {
    embed.addFields({
      name: `#${club.id} · ${club.name}`,
      value: `${topicLabels[club.topic] || 'Khác'} · ${club.members} thành viên\n${club.description.slice(0, 200)}`
    });
  }
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

function showConstellation(interaction) {
  const profiles = db.prepare(`SELECT userId, interests FROM dating_profiles
    WHERE guildId = ? AND enabled = 1 AND age >= 18`).all(interaction.guild.id);
  const clusters = new Map();
  for (const profile of profiles) {
    let interests = [];
    try { interests = JSON.parse(profile.interests || '[]'); } catch { interests = []; }
    for (const interest of interests) {
      const cluster = clusters.get(interest) || [];
      cluster.push(profile.userId);
      clusters.set(interest, cluster);
    }
  }
  const top = [...clusters.entries()].filter(([, members]) => members.length > 1)
    .sort((left, right) => right[1].length - left[1].length).slice(0, 8);
  if (!top.length) return interaction.reply({ content: 'Chòm sao sẽ hiện khi có ít nhất hai hồ sơ bật chia sẻ cùng một sở thích.', ephemeral: true });
  const embed = new EmbedBuilder().setColor(gzw.brandColor).setTitle('🌌 Chòm sao cộng đồng')
    .setDescription(top.map(([interest, members]) => `✨ **${interest}** · ${members.length} thành viên\n${members.slice(0, 8).map((id) => `<@${id}>`).join(' ')}`).join('\n\n'))
    .setFooter({ text: 'Chỉ tính hồ sơ đang bật và sở thích do thành viên tự chia sẻ.' });
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

function createCapsule(interaction) {
  const audience = interaction.options.getString('doi-tuong');
  const days = interaction.options.getInteger('thoi-gian');
  const content = interaction.options.getString('noi-dung').trim();
  const deliverAt = Date.now() + days * 86400000;
  const result = db.prepare(`INSERT INTO time_capsules (guildId, userId, audience, channelId, content, deliverAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(interaction.guild.id, interaction.user.id, audience, audience === 'community' ? interaction.channelId : null, content, deliverAt, Date.now());
  const date = `<t:${Math.floor(deliverAt / 1000)}:F>`;
  return interaction.reply({
    content: audience === 'self'
      ? `✅ Đã niêm phong thư #${result.lastInsertRowid}. Bot sẽ DM bạn vào ${date}.`
      : `✅ Đã niêm phong thư #${result.lastInsertRowid}. Bot sẽ đăng vào kênh này vào ${date}.`,
    ephemeral: true
  });
}

function listCapsules(interaction) {
  const rows = db.prepare(`SELECT id, audience, deliverAt, status FROM time_capsules
    WHERE guildId = ? AND userId = ? AND status IN ('pending', 'failed') ORDER BY deliverAt LIMIT 10`)
    .all(interaction.guild.id, interaction.user.id);
  if (!rows.length) return interaction.reply({ content: 'Bạn không có time capsule nào đang chờ.', ephemeral: true });
  return interaction.reply({ content: rows.map((row) => `#${row.id} · ${row.audience === 'self' ? 'riêng tư' : 'cộng đồng'} · <t:${Math.floor(row.deliverAt / 1000)}:R> · ${row.status}`).join('\n'), ephemeral: true });
}

function cancelCapsule(interaction) {
  const id = interaction.options.getInteger('id');
  const changed = db.prepare(`UPDATE time_capsules SET status = 'cancelled'
    WHERE id = ? AND guildId = ? AND userId = ? AND status IN ('pending', 'failed')`)
    .run(id, interaction.guild.id, interaction.user.id).changes;
  return interaction.reply({ content: changed ? `✅ Đã huỷ thư #${id}.` : 'Không tìm thấy thư đang chờ của bạn.', ephemeral: true });
}

module.exports = {
  group: 'Kết nối cộng đồng',
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Kết nối cộng đồng, câu lạc bộ và hộp thời gian')
    .setDMPermission(false)
    .addSubcommandGroup((g) => g.setName('admirer').setDescription('Lời khen và phản hồi ẩn danh')
      .addSubcommand((s) => s.setName('send').setDescription('Gửi một lời khen ẩn danh')
        .addUserOption((o) => o.setName('nguoi-nhan').setDescription('Thành viên nhận lời khen').setRequired(true))
        .addStringOption((o) => o.setName('loi-khen').setDescription('Lời khen lịch sự').setRequired(true).setMinLength(5).setMaxLength(300)))
      .addSubcommand((s) => s.setName('inbox').setDescription('Đọc lời khen ẩn danh'))
      .addSubcommand((s) => s.setName('reply').setDescription('Phản hồi ẩn danh cho lời khen')
        .addIntegerOption((o) => o.setName('id').setDescription('Mã lời khen').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('loi-nhan').setDescription('Nội dung phản hồi').setRequired(true).setMinLength(2).setMaxLength(300))))
    .addSubcommandGroup((g) => g.setName('quest').setDescription('Friendship Quest theo nhóm 3')
      .addSubcommand((s) => s.setName('join').setDescription('Vào hàng chờ làm quen'))
      .addSubcommand((s) => s.setName('finish').setDescription('Kết thúc Friendship Quest trong thread')))
    .addSubcommandGroup((g) => g.setName('club').setDescription('DIS Clubs theo sở thích')
      .addSubcommand((s) => s.setName('create').setDescription('Tạo câu lạc bộ và thread công khai')
        .addStringOption((o) => o.setName('ten').setDescription('Tên club').setRequired(true).setMinLength(3).setMaxLength(50))
        .addStringOption((o) => o.setName('chu-de').setDescription('Chủ đề').setRequired(true).addChoices(...topics))
        .addStringOption((o) => o.setName('mo-ta').setDescription('Giới thiệu club').setRequired(true).setMinLength(10).setMaxLength(250)))
      .addSubcommand((s) => s.setName('list').setDescription('Xem các DIS Club trong server'))
      .addSubcommand((s) => s.setName('join').setDescription('Tham gia một club')
        .addIntegerOption((o) => o.setName('id').setDescription('Mã club').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('leave').setDescription('Rời một club')
        .addIntegerOption((o) => o.setName('id').setDescription('Mã club').setRequired(true).setMinValue(1))))
    .addSubcommand((s) => s.setName('constellation').setDescription('Xem chòm sao sở thích của server'))
    .addSubcommandGroup((g) => g.setName('capsule').setDescription('Gửi thư đến tương lai')
      .addSubcommand((s) => s.setName('create').setDescription('Niêm phong một lá thư')
        .addStringOption((o) => o.setName('doi-tuong').setDescription('Người nhận thư').setRequired(true)
          .addChoices({ name: 'Chỉ mình tôi (DM)', value: 'self' }, { name: 'Cộng đồng tại kênh này', value: 'community' }))
        .addIntegerOption((o) => o.setName('thoi-gian').setDescription('Thời điểm gửi').setRequired(true).addChoices(...capsuleDelays))
        .addStringOption((o) => o.setName('noi-dung').setDescription('Nội dung bức thư').setRequired(true).setMinLength(10).setMaxLength(1500)))
      .addSubcommand((s) => s.setName('list').setDescription('Xem các thư đang chờ'))
      .addSubcommand((s) => s.setName('cancel').setDescription('Huỷ thư chưa gửi')
        .addIntegerOption((o) => o.setName('id').setDescription('Mã thư').setRequired(true).setMinValue(1)))),

  async execute(interaction, client) {
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();
    if (group === 'admirer') {
      if (subcommand === 'send') return sendAdmirer(interaction, client);
      if (subcommand === 'inbox') return admirerInbox(interaction);
      return replyAdmirer(interaction, client);
    }
    if (group === 'quest') return subcommand === 'join' ? joinQuest(interaction, client) : finishQuest(interaction, client);
    if (group === 'club') {
      if (subcommand === 'create') return createClub(interaction, client);
      if (subcommand === 'list') return listClubs(interaction);
      return joinClub(interaction, subcommand === 'join');
    }
    if (subcommand === 'constellation') return showConstellation(interaction);
    if (group === 'capsule') {
      if (subcommand === 'create') return createCapsule(interaction);
      if (subcommand === 'list') return listCapsules(interaction);
      return cancelCapsule(interaction);
    }
  }
};