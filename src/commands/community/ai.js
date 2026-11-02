const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db');
const gzw = require('../../config/gzw');

const avatarStyles = [
  { name: 'Turquoise', value: 'teal' },
  { name: 'Hồng san hô', value: 'coral' },
  { name: 'Hổ phách', value: 'amber' },
  { name: 'Xanh lá', value: 'green' },
  { name: 'Xanh biển', value: 'blue' }
];
const personalityChoices = [
  { name: 'Kết nối', value: 'connect' },
  { name: 'Quan sát', value: 'observe' },
  { name: 'Khám phá', value: 'explore' },
  { name: 'Lên kế hoạch', value: 'plan' }
];
const personalities = {
  connect: { name: 'Người kết nối', color: 0x31a89c, text: 'Bạn thường tạo năng lượng bằng những cuộc trò chuyện và sự đồng hành.' },
  observe: { name: 'Người tinh tế', color: 0x6889c8, text: 'Bạn thích lắng nghe, quan sát và suy nghĩ kỹ trước khi chia sẻ.' },
  explore: { name: 'Người khám phá', color: 0xe58b57, text: 'Bạn thích trải nghiệm mới, ý tưởng mới và những cuộc trò chuyện bất ngờ.' },
  plan: { name: 'Người kiến tạo', color: 0x8c73b7, text: 'Bạn thích biến ý tưởng thành kế hoạch rõ ràng và cùng nhau hoàn thành.' }
};
const topicStarters = {
  music: ['Bài hát nào luôn kéo bạn về một kỷ niệm vui?', 'Nếu tạo playlist cho một chuyến đi, bạn sẽ chọn bài mở đầu nào?'],
  games: ['Game nào bạn muốn được chơi lại lần đầu tiên?', 'Bạn thích khám phá thế giới game hay phối hợp cùng đồng đội hơn?'],
  anime: ['Nhân vật nào khiến bạn thay đổi cách nhìn về một câu chuyện?', 'Nếu sống trong một thế giới anime một ngày, bạn chọn thế giới nào?'],
  movies: ['Bộ phim nào bạn có thể xem lại nhiều lần?', 'Bạn thích một cái kết bất ngờ hay một cái kết ấm áp?'],
  books: ['Cuốn sách nào khiến bạn muốn kể ngay cho người khác?', 'Bạn thường chọn sách theo chủ đề hay theo cảm giác lúc đó?'],
  technology: ['Công nghệ nhỏ nào đang làm cuộc sống bạn dễ hơn?', 'Nếu tự làm một ứng dụng cuối tuần này, bạn sẽ làm gì?'],
  study: ['Bạn học tốt nhất khi tự tìm hiểu hay cùng trao đổi?', 'Có kỹ năng nào bạn muốn học cùng một người bạn không?']
};

function parseInterests(profile) {
  try {
    const interests = JSON.parse(profile?.interests || '[]');
    return Array.isArray(interests) ? interests : [];
  } catch {
    return [];
  }
}

async function askModel(messages, maxTokens = 450) {
  const apiKey = process.env.AI_API_KEY;
  const endpoint = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  if (!apiKey) throw new Error('AI_API_KEY chưa được cấu hình');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('AI_API_URL không hợp lệ'); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('AI_API_URL phải dùng HTTPS');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`AI provider trả về HTTP ${response.status}`);
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI provider không trả về nội dung');
  return content.trim().slice(0, 1800);
}

async function assistant(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const answer = await askModel([
      { role: 'system', content: 'Bạn là DIS Assistant, trợ lý thân thiện cho cộng đồng Discord. Trả lời ngắn gọn bằng tiếng Việt. Không giả vờ biết nội quy hay dữ liệu server nếu chưa được cung cấp; khi thiếu thông tin, nói rõ điều đó. Không đưa chẩn đoán y tế/tâm lý.' },
      { role: 'user', content: interaction.options.getString('cau-hoi') }
    ]);
    return interaction.editReply({ content: answer, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('❌ AI assistant:', error.message);
    return interaction.editReply('Trợ lý AI chưa sẵn sàng. Quản trị viên cần cấu hình AI_API_KEY và AI_API_URL trong `.env`.');
  }
}

function personality(interaction) {
  const counts = { connect: 0, observe: 0, explore: 0, plan: 0 };
  for (let index = 1; index <= 5; index++) counts[interaction.options.getString(`cau-${index}`)]++;
  const [type, score] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const result = personalities[type];
  const embed = new EmbedBuilder()
    .setColor(result.color)
    .setTitle(`🧩 AI Personality · ${result.name}`)
    .setDescription(`${result.text}\n\nĐây là bài trắc nghiệm giải trí, không phải đánh giá hay chẩn đoán tâm lý.`)
    .addFields({ name: 'Kết quả', value: `${score}/5 câu nghiêng về phong cách này.` });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function conversationTopic(interaction) {
  const other = interaction.options.getUser('nguoi-match');
  if (other.id === interaction.user.id) return interaction.reply({ content: 'Hãy chọn người bạn đã match với mình.', ephemeral: true });
  const [userA, userB] = [interaction.user.id, other.id].sort();
  const matched = db.prepare('SELECT 1 FROM dating_matches WHERE guildId = ? AND userA = ? AND userB = ?').get(interaction.guild.id, userA, userB);
  if (!matched) return interaction.reply({ content: 'Conversation Generator chỉ dùng với người bạn đã match.', ephemeral: true });

  const profiles = db.prepare('SELECT userId, interests FROM dating_profiles WHERE guildId = ? AND userId IN (?, ?)')
    .all(interaction.guild.id, userA, userB);
  const first = parseInterests(profiles.find((profile) => profile.userId === userA));
  const second = new Set(parseInterests(profiles.find((profile) => profile.userId === userB)));
  const shared = first.filter((interest) => second.has(interest));
  let prompt;
  if (process.env.AI_API_KEY && shared.length) {
    try {
      prompt = await askModel([
        { role: 'system', content: 'Tạo một câu hỏi mở, thân thiện, bằng tiếng Việt để hai người mới quen bắt đầu nói chuyện. Chỉ dựa trên sở thích chung được cung cấp; không hỏi dữ liệu nhạy cảm.' },
        { role: 'user', content: `Sở thích chung: ${shared.join(', ')}` }
      ], 100);
    } catch (error) {
      console.warn('⚠️ AI topic fallback:', error.message);
    }
  }
  if (!prompt) {
    const key = shared.find((interest) => topicStarters[interest]) || 'games';
    const prompts = topicStarters[key];
    prompt = prompts[Math.floor(Math.random() * prompts.length)];
    if (shared.length) prompt = `Sở thích chung: **${shared.join(', ')}**\n\n${prompt}`;
  }
  return interaction.reply({ content: prompt, ephemeral: true, allowedMentions: { parse: [] } });
}

function setAvatarStyle(interaction) {
  const style = interaction.options.getString('phong-cach');
  db.prepare(`INSERT INTO social_avatar_styles (guildId, userId, style, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT (guildId, userId) DO UPDATE SET style = excluded.style, updatedAt = excluded.updatedAt`)
    .run(interaction.guild.id, interaction.user.id, style, Date.now());
  return interaction.reply({ content: `✅ Đã áp dụng phong cách **${avatarStyles.find((item) => item.value === style)?.name}** cho Tinder card của bạn.`, ephemeral: true });
}

module.exports = {
  group: 'AI & Hồ sơ',
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Trợ lý AI, personality, chủ đề trò chuyện và avatar studio')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('assistant').setDescription('Hỏi DIS Assistant')
      .addStringOption((o) => o.setName('cau-hoi').setDescription('Câu hỏi của bạn').setRequired(true).setMinLength(2).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('personality').setDescription('Làm trắc nghiệm tính cách vui (5 câu)')
      .addStringOption((o) => o.setName('cau-1').setDescription('Khi rảnh bạn thường chọn gì?').setRequired(true).addChoices(...personalityChoices))
      .addStringOption((o) => o.setName('cau-2').setDescription('Điều gì làm bạn hứng thú?').setRequired(true).addChoices(...personalityChoices))
      .addStringOption((o) => o.setName('cau-3').setDescription('Trong nhóm bạn thường làm gì?').setRequired(true).addChoices(...personalityChoices))
      .addStringOption((o) => o.setName('cau-4').setDescription('Một kế hoạch tốt cần gì?').setRequired(true).addChoices(...personalityChoices))
      .addStringOption((o) => o.setName('cau-5').setDescription('Bạn muốn người khác nhớ điều gì?').setRequired(true).addChoices(...personalityChoices)))
    .addSubcommand((s) => s.setName('topic').setDescription('Tạo chủ đề nói chuyện với người đã match')
      .addUserOption((o) => o.setName('nguoi-match').setDescription('Người đã match với bạn').setRequired(true)))
    .addSubcommand((s) => s.setName('avatar').setDescription('Đổi màu profile card Tinder')
      .addStringOption((o) => o.setName('phong-cach').setDescription('Chọn màu viền card').setRequired(true).addChoices(...avatarStyles))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'assistant') return assistant(interaction);
    if (subcommand === 'personality') return personality(interaction);
    if (subcommand === 'topic') return conversationTopic(interaction);
    return setAvatarStyle(interaction);
  }
};
