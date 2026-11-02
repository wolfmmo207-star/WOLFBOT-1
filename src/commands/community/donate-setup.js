const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder
} = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');

async function getOrCreateChannel(interaction, selected, name, topic) {
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

module.exports = {
  group: 'Cộng đồng (Quản trị)',
  cooldown: 10,
  data: new SlashCommandBuilder()
    .setName('donate-setup')
    .setDescription('Tạo và cấu hình kênh donate cùng feedback')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('kenh-donate').setDescription('Chọn kênh text có sẵn').addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) => o.setName('kenh-feedback').setDescription('Chọn kênh text có sẵn').addChannelTypes(ChannelType.GuildText)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const missingChannels = !interaction.options.getChannel('kenh-donate') || !interaction.options.getChannel('kenh-feedback');
      if (missingChannels && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.editReply('Bot cần quyền **Manage Channels** để tự tạo các kênh còn thiếu.');
      }

      const donationChannel = await getOrCreateChannel(
        interaction,
        interaction.options.getChannel('kenh-donate'),
        gzw.community.donationChannelName,
        'QR donate theo từng đơn được đăng tại đây.'
      );
      const feedbackChannel = await getOrCreateChannel(
        interaction,
        interaction.options.getChannel('kenh-feedback'),
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
};