const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');

const intents = [
  { name: 'Tình bạn', value: 'friendship' },
  { name: 'Hẹn hò', value: 'dating' },
  { name: 'Cả hai', value: 'both' }
];
const intentLabels = Object.fromEntries(intents.map((item) => [item.value, item.name]));

function communityChannel(guild, channelName) {
  return guild.channels.cache.find((channel) => channel.name === channelName && channel.isTextBased());
}

function profileCard(profile, user) {
  const embed = new EmbedBuilder()
    .setColor(gzw.brandColor)
    .setTitle(`🐺 ${user.username}`)
    .setDescription(profile.bio)
    .addFields(
      { name: 'Tuổi', value: String(profile.age), inline: true },
      { name: 'Đang tìm', value: intentLabels[profile.lookingFor], inline: true }
    );
  if (user.displayAvatarURL) embed.setThumbnail(user.displayAvatarURL());
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

async function browsePayload(interaction, client) {
  const profile = nextProfile(interaction.guild.id, interaction.user.id);
  if (!profile) return { content: 'Chưa có hồ sơ mới để xem. Hãy quay lại sau nhé.', embeds: [], components: [] };

  const user = await client.users.fetch(profile.userId).catch(() => null);
  if (!user) return { content: 'Hồ sơ này không thể tải. Hãy thử khám phá lại sau.', embeds: [], components: [] };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dating:like:${profile.userId}`).setLabel('Thích').setEmoji('💚').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dating:pass:${profile.userId}`).setLabel('Bỏ qua').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [profileCard(profile, user)], components: [row] };
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
        .addChoices(...intents)))
    .addSubcommand((s) => s.setName('discover').setDescription('Xem hồ sơ và chọn thích hoặc bỏ qua'))
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
      db.prepare(`INSERT INTO dating_profiles (guildId, userId, age, bio, lookingFor, enabled, updatedAt)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT (guildId, userId) DO UPDATE SET
          age = excluded.age, bio = excluded.bio, lookingFor = excluded.lookingFor,
          enabled = 1, updatedAt = excluded.updatedAt`).run(guildId, userId, age, bio, lookingFor, Date.now());
      return interaction.reply({ content: '✅ Hồ sơ đã bật. Hồ sơ chỉ hiển thị trong server này; tuổi từ 18 trở lên dựa trên xác nhận của bạn.', ephemeral: true });
    }

    if (subcommand === 'discover') {
      const ownProfile = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(guildId, userId);
      if (!ownProfile?.enabled) return interaction.reply({ content: 'Hãy tạo hoặc bật hồ sơ bằng `/social profile` trước khi khám phá.', ephemeral: true });
      return interaction.reply({ ...(await browsePayload(interaction, client)), ephemeral: true });
    }

    if (subcommand === 'pause') {
      const changed = db.prepare('UPDATE dating_profiles SET enabled = 0, updatedAt = ? WHERE guildId = ? AND userId = ?').run(Date.now(), guildId, userId).changes;
      return interaction.reply({ content: changed ? '✅ Hồ sơ đã được ẩn.' : 'Bạn chưa có hồ sơ ghép đôi.', ephemeral: true });
    }

    if (subcommand === 'erase') {
      const erase = db.transaction(() => {
        db.prepare('DELETE FROM dating_swipes WHERE guildId = ? AND (fromUserId = ? OR toUserId = ?)').run(guildId, userId, userId);
        db.prepare('DELETE FROM dating_matches WHERE guildId = ? AND (userA = ? OR userB = ?)').run(guildId, userId, userId);
        return db.prepare('DELETE FROM dating_profiles WHERE guildId = ? AND userId = ?').run(guildId, userId).changes;
      });
      const changed = erase();
      return interaction.reply({ content: changed ? '✅ Hồ sơ, lượt quẹt và kết nối của bạn đã được xoá.' : 'Bạn chưa có hồ sơ ghép đôi.', ephemeral: true });
    }

    if (subcommand === 'confession' || subcommand === 'feedback') {
      const isConfession = subcommand === 'confession';
      const channelName = isConfession ? gzw.community.confessionChannelName : gzw.community.feedbackChannelName;
      const channel = communityChannel(interaction.guild, channelName);
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
    if (!['like', 'pass'].includes(action) || !/^\d{17,20}$/.test(targetId) || targetId === interaction.user.id) {
      return interaction.reply({ content: 'Lựa chọn này không hợp lệ.', ephemeral: true });
    }

    const target = db.prepare('SELECT enabled FROM dating_profiles WHERE guildId = ? AND userId = ? AND age >= 18').get(interaction.guild.id, targetId);
    if (!target?.enabled) return interaction.update({ content: 'Hồ sơ này không còn khả dụng.', embeds: [], components: [] });

    const swipe = db.prepare('INSERT OR IGNORE INTO dating_swipes (guildId, fromUserId, toUserId, action, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(interaction.guild.id, interaction.user.id, targetId, action, Date.now());
    if (!swipe.changes) return interaction.update(await browsePayload(interaction, client));

    let matched = false;
    if (action === 'like') {
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
      const message = `💚 Hai bạn và <@${targetId}> đã thích nhau! Có thể nhắn tin cho nhau trên Discord.`;
      await interaction.user.send(message).catch(() => {});
      await other?.send(`💚 Hai bạn và <@${interaction.user.id}> đã thích nhau! Có thể nhắn tin cho nhau trên Discord.`).catch(() => {});
    }

    const payload = await browsePayload(interaction, client);
    if (matched) payload.content = '💚 Ghép đôi thành công! ' + (payload.content || '');
    else if (action === 'like') payload.content = 'Đã gửi lượt thích. ' + (payload.content || '');
    return interaction.update(payload);
  }
};