const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../database/db');

const providers = [
  { name: 'TikTok', value: 'tiktok', column: 'tiktokEnabled' },
  { name: 'SoundCloud', value: 'soundcloud', column: 'soundcloudEnabled' },
  { name: 'Douyin', value: 'douyin', column: 'douyinEnabled' },
  { name: 'Facebook', value: 'facebook', column: 'facebookEnabled' },
  { name: 'YouTube', value: 'youtube', column: 'youtubeEnabled' }
];

module.exports = {
  group: 'Cộng đồng (Quản trị)',
  cooldown: 3,
  data: new SlashCommandBuilder()
    .setName('autodown')
    .setDescription('Cấu hình auto-down link công khai trong server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('status').setDescription('Xem trạng thái AutoDown'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Bật/tắt một nền tảng')
      .addStringOption((o) => o.setName('nen-tang').setDescription('Nền tảng').setRequired(true)
        .addChoices(...providers.map((provider) => ({ name: provider.name, value: provider.value })))
      )
      .addBooleanOption((o) => o.setName('bat').setDescription('Bật hoặc tắt nền tảng').setRequired(true)))
    .addSubcommand((s) => s.setName('enabled').setDescription('Bật/tắt toàn bộ AutoDown')
      .addBooleanOption((o) => o.setName('bat').setDescription('Bật hoặc tắt AutoDown').setRequired(true))),

  async execute(interaction) {
    const settings = db.prepare('SELECT * FROM autodown_settings WHERE guildId = ?').get(interaction.guild.id);
    if (!settings) return interaction.reply({ content: 'Chạy `/setup autodown` để chọn channel trước.', ephemeral: true });

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'status') {
      const state = (enabled) => enabled ? '✅ Bật' : '⏸️ Tắt';
      const lines = providers.map((provider) => `${provider.name}: ${state(settings[provider.column])}`);
      return interaction.reply({ content: `AutoDown ${state(settings.enabled)} trong <#${settings.channelId}>\n${lines.join('\n')}`, ephemeral: true });
    }

    if (subcommand === 'enabled') {
      const enabled = interaction.options.getBoolean('bat') ? 1 : 0;
      db.prepare('UPDATE autodown_settings SET enabled = ?, updatedAt = ? WHERE guildId = ?').run(enabled, Date.now(), interaction.guild.id);
      return interaction.reply({ content: `✅ AutoDown đã ${enabled ? 'bật' : 'tắt'} trong server này.`, ephemeral: true });
    }

    const provider = providers.find((item) => item.value === interaction.options.getString('nen-tang'));
    const enabled = interaction.options.getBoolean('bat') ? 1 : 0;
    db.prepare(`UPDATE autodown_settings SET ${provider.column} = ?, updatedAt = ? WHERE guildId = ?`)
      .run(enabled, Date.now(), interaction.guild.id);
    return interaction.reply({ content: `✅ ${provider.name} đã ${enabled ? 'bật' : 'tắt'}.`, ephemeral: true });
  }
};