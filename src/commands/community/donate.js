const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const gzw = require('../../config/gzw');
const db = require('../../database/db');
const { createDonationOrder } = require('../../services/sepay');

module.exports = {
  group: 'Cộng đồng',
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('donate')
    .setDescription('Tạo QR chuyển khoản ủng hộ server')
    .setDMPermission(false)
    .addIntegerOption((o) => o.setName('so-tien').setDescription('Số tiền ủng hộ (VND)').setRequired(true).setMinValue(2000).setMaxValue(200000000)),

  async execute(interaction) {
    const settings = db.prepare('SELECT donationChannelId FROM donation_settings WHERE guildId = ?').get(interaction.guild.id);
    if (!settings) {
      return interaction.reply({ content: 'Quản trị viên cần chạy `/donate-setup` trước để tạo kênh donate và feedback.', ephemeral: true });
    }

    const inDonationChannel = interaction.channelId === settings.donationChannelId;
    await interaction.deferReply({ ephemeral: !inDonationChannel });
    try {
      const order = await createDonationOrder({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        amount: interaction.options.getInteger('so-tien')
      });

      const embed = new EmbedBuilder()
        .setColor(gzw.brandColor)
        .setTitle('💜 Đơn ủng hộ server')
        .setDescription(`Số tiền: **${new Intl.NumberFormat('vi-VN').format(order.amount)} VND**\nNội dung chuyển khoản: \`${order.transferContent}\`\nĐơn sẽ tự xác nhận sau khi SePay ghi nhận giao dịch.`)
        .setImage(order.qrUrl);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Mở mã QR').setStyle(ButtonStyle.Link).setURL(order.qrUrl)
      );
      const payload = { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
      if (inDonationChannel) return interaction.editReply(payload);

      const channel = await interaction.guild.channels.fetch(settings.donationChannelId).catch(() => null);
      if (!channel?.isTextBased()) return interaction.editReply({ content: 'Kênh donate không còn khả dụng. Hãy yêu cầu quản trị viên chạy lại `/donate-setup`.' });
      await channel.send(payload);
      return interaction.editReply({ content: `✅ QR đơn **${order.transferContent}** đã được đăng tại ${channel}.` });
    } catch (error) {
      console.error('❌ Không thể tạo đơn donate SePay:', error.message);
      return interaction.editReply({ content: 'Không thể tạo đơn donate lúc này. Hãy báo quản trị server kiểm tra cấu hình SePay.' });
    }
  }
};