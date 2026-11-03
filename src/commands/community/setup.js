const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');
const { postSetupPanel } = require('../../services/werewolf');
const { postRandomTalkPanel } = require('../../services/randomTalk');

async function getOrCreateDonationChannel(interaction, selected, name, topic) {
  if (selected) return selected;
  const existing = interaction.guild.channels.cache.find((channel) => channel.name === name && channel.type === ChannelType.GuildText);
  if (existing) return existing;
  return interaction.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
    reason: `Thiết lập hệ thống donate bởi ${interaction.user.tag}`
  });
}

async function setupDonation(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const donationOption = interaction.options.getChannel('kenh-donate');
    const feedbackOption = interaction.options.getChannel('kenh-feedback');
    if ((!donationOption || !feedbackOption) && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply('Bot cần quyền **Manage Channels** để tự tạo các kênh còn thiếu.');
    }

    const donationChannel = await getOrCreateDonationChannel(
      interaction,
      donationOption,
      gzw.community.donationChannelName,
      'QR donate theo từng đơn được đăng tại đây.'
    );
    const feedbackChannel = await getOrCreateDonationChannel(
      interaction,
      feedbackOption,
      gzw.community.feedbackChannelName,
      'Feedback và thông báo donate đã xác nhận.'
    );

    db.prepare(`INSERT INTO donation_settings (guildId, donationChannelId, feedbackChannelId, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (guildId) DO UPDATE SET donationChannelId = excluded.donationChannelId,
        feedbackChannelId = excluded.feedbackChannelId, updatedAt = excluded.updatedAt`)
      .run(interaction.guild.id, donationChannel.id, feedbackChannel.id, Date.now());

    const panel = new EmbedBuilder()
      .setColor(gzw.brandColor)
      .setTitle('💜 Ủng hộ server')
      .setDescription('Dùng lệnh `/donate so-tien` để tạo QR riêng cho khoản ủng hộ. Hãy chuyển đúng số tiền và giữ nguyên nội dung chuyển khoản trên QR để bot tự đối soát.')
      .addFields({ name: 'Kênh nhận xác nhận', value: `${feedbackChannel}` })
      .setFooter({ text: 'Mỗi đơn có QR và mã chuyển khoản riêng.' });
    const previousSettings = db.prepare('SELECT panelMessageId FROM donation_settings WHERE guildId = ?').get(interaction.guild.id);
    const previousMessage = previousSettings?.panelMessageId
      ? await donationChannel.messages.fetch(previousSettings.panelMessageId).catch(() => null)
      : null;
    const panelMessage = previousMessage
      ? await previousMessage.edit({ embeds: [panel] })
      : await donationChannel.send({ embeds: [panel], allowedMentions: { parse: [] } });
    db.prepare('UPDATE donation_settings SET panelMessageId = ?, updatedAt = ? WHERE guildId = ?')
      .run(panelMessage.id, Date.now(), interaction.guild.id);

    return interaction.editReply(`✅ Đã cấu hình donate: ${donationChannel}\n✅ Kênh thông báo: ${feedbackChannel}\nBảng hướng dẫn đã được đăng trong kênh donate.`);
  } catch (error) {
    console.error('❌ Không thể thiết lập kênh donate:', error.message);
    return interaction.editReply('Không thể thiết lập kênh. Kiểm tra quyền **Manage Channels**, **View Channel**, **Send Messages** và **Embed Links** của bot.');
  }
}

async function setupSocial(interaction) {
  const confessionChannel = interaction.options.getChannel('kenh-confession');
  const tinderChannel = interaction.options.getChannel('kenh-tinder');
  const maleRole = interaction.options.getRole('role-nam');
  const femaleRole = interaction.options.getRole('role-nu');
  if (Boolean(maleRole) !== Boolean(femaleRole)) {
    return interaction.reply({ content: 'Hãy chọn cả role nam và role nữ, hoặc bỏ trống cả hai để dùng giới tính trong hồ sơ.', ephemeral: true });
  }
  if (maleRole && maleRole.id === femaleRole.id) {
    return interaction.reply({ content: 'Role nam và role nữ phải khác nhau.', ephemeral: true });
  }
  db.prepare(`INSERT INTO social_settings (guildId, confessionChannelId, tinderChannelId, maleRoleId, femaleRoleId, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (guildId) DO UPDATE SET confessionChannelId = excluded.confessionChannelId,
      tinderChannelId = excluded.tinderChannelId, maleRoleId = excluded.maleRoleId,
      femaleRoleId = excluded.femaleRoleId, updatedAt = excluded.updatedAt`)
    .run(interaction.guild.id, confessionChannel.id, tinderChannel.id, maleRole?.id || null, femaleRole?.id || null, Date.now());

  const embed = new EmbedBuilder()
    .setColor(gzw.brandColor)
    .setTitle('💞 Tìm người trò chuyện')
    .setDescription('Bấm nút tìm nam hoặc nữ. Bot chỉ ghép khi hai người chọn tìm nhau; khi ghép thành công sẽ mở private thread cho hai bạn. Bấm **Hủy tìm** để rời hàng chờ.')
    .setFooter({ text: maleRole ? 'Giới tính được xác định theo role server.' : 'Hãy tạo profile và chọn giới tính trước khi tìm.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dating:queue:female').setLabel('Tìm nữ').setEmoji('👩').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dating:queue:male').setLabel('Tìm nam').setEmoji('👨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dating:queue:cancel').setLabel('Hủy tìm').setEmoji('⏹️').setStyle(ButtonStyle.Secondary)
  );
  const settings = db.prepare('SELECT tinderPanelMessageId FROM social_settings WHERE guildId = ?').get(interaction.guild.id);
  const oldPanel = settings?.tinderPanelMessageId
    ? await tinderChannel.messages.fetch(settings.tinderPanelMessageId).catch(() => null)
    : null;
  const panel = oldPanel
    ? await oldPanel.edit({ embeds: [embed], components: [row] })
    : await tinderChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  db.prepare('UPDATE social_settings SET tinderPanelMessageId = ?, updatedAt = ? WHERE guildId = ?')
    .run(panel.id, Date.now(), interaction.guild.id);

  return interaction.reply({
    content: `✅ Đã lưu kênh confession: ${confessionChannel}\n✅ Đã đăng bảng ghép đôi tại ${tinderChannel}${maleRole ? `\nRole nam: ${maleRole} · role nữ: ${femaleRole}` : '\nDùng giới tính trong profile để ghép.'}`,
    ephemeral: true
  });
}

async function setupAutoDown(interaction) {
  const channel = interaction.options.getChannel('kenh');
  db.prepare(`INSERT INTO autodown_settings (guildId, channelId, enabled, updatedAt)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (guildId) DO UPDATE SET channelId = excluded.channelId, updatedAt = excluded.updatedAt`)
    .run(interaction.guild.id, channel.id, Date.now());
  return interaction.reply({ content: `✅ AutoDown chỉ xử lý link trong ${channel}. Dùng [0m/autodown status để xem nền tảng đang bật.`, ephemeral: true });
}

async function setupWerewolf(interaction) {
  const channel = interaction.options.getChannel('kenh');
  db.prepare(`INSERT INTO werewolf_settings (guildId, channelId, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT (guildId) DO UPDATE SET channelId = excluded.channelId, updatedAt = excluded.updatedAt`)
    .run(interaction.guild.id, channel.id, Date.now());

  const panel = await postSetupPanel(interaction.guild, channel);
  return interaction.reply({ content: `✅ Đã cấu hình bảng Ma Sói tại ${channel}.`, ephemeral: true });
}

async function setupRandomTalk(interaction) {
  const channel = interaction.options.getChannel('kenh');
  db.prepare(`INSERT INTO random_talk_settings (guildId, channelId, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT (guildId) DO UPDATE SET channelId = excluded.channelId, updatedAt = excluded.updatedAt`)
    .run(interaction.guild.id, channel.id, Date.now());
  await postRandomTalkPanel(interaction.guild, channel);
  return interaction.reply({ content: `✅ Đã cấu hình Random Talk tại ${channel}. Tinder vẫn ở channel riêng đã chọn trong /setup social.`, ephemeral: true });
}

module.exports = {
  group: 'Cộng đồng (Quản trị)',
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cấu hình các kênh cộng đồng')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('donate').setDescription('Cấu hình kênh donate và feedback')
      .addChannelOption((o) => o.setName('kenh-donate').setDescription('Chọn kênh donate có sẵn').addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('kenh-feedback').setDescription('Chọn kênh feedback có sẵn').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('social').setDescription('Gán kênh confession và Tinder đã tạo')
      .addChannelOption((o) => o.setName('kenh-confession').setDescription('Kênh đăng confession ẩn danh').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('kenh-tinder').setDescription('Kênh Tinder và bảng ghép đôi').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addRoleOption((o) => o.setName('role-nam').setDescription('Role giới tính nam (tùy chọn)'))
      .addRoleOption((o) => o.setName('role-nu').setDescription('Role giới tính nữ (tùy chọn')))
    .addSubcommand((s) => s.setName('autodown').setDescription('Chọn kênh tự động tải link')
      .addChannelOption((o) => o.setName('kenh').setDescription('Kênh text xử lý link công khai').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('werewolf').setDescription('Đăng bảng tạo Ma Sói trong channel có sẵn')
      .addChannelOption((o) => o.setName('kenh').setDescription('Kênh bảng Ma Sói').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('random-talk').setDescription('Đăng bảng ghép nói chuyện ngẫu nhiên')
      .addChannelOption((o) => o.setName('kenh').setDescription('Kênh Random Talk riêng').setRequired(true).addChannelTypes(ChannelType.GuildText))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'donate') return setupDonation(interaction);
    if (subcommand === 'autodown') return setupAutoDown(interaction);
    if (subcommand === 'werewolf') return setupWerewolf(interaction);
    if (subcommand === 'random-talk') return setupRandomTalk(interaction);
    return setupSocial(interaction);
  }
};