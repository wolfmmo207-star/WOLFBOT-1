const { AttachmentBuilder } = require('discord.js');
const db = require('../database/db');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const USER_COOLDOWN_MS = 30000;
const lastRequest = new Map();
const providers = {
  tiktok: { enabledColumn: 'tiktokEnabled', hosts: ['tiktok.com'] },
  soundcloud: { enabledColumn: 'soundcloudEnabled', hosts: ['soundcloud.com'] },
  douyin: { enabledColumn: 'douyinEnabled', hosts: ['douyin.com'] },
  facebook: { enabledColumn: 'facebookEnabled', hosts: ['facebook.com', 'fb.watch'] },
  youtube: { enabledColumn: 'youtubeEnabled', hosts: ['youtube.com', 'youtu.be'] }
};

function safeHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  return url;
}

function platformFor(link) {
  const url = safeHttpsUrl(link);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const [platform, entry] of Object.entries(providers)) {
    if (entry.hosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return { platform, url };
  }
  return null;
}

async function fetchTikTok(url) {
  const response = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: url.toString() }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`TikTok provider HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 0 || !body.data) throw new Error('TikTok provider không trả media công khai');
  const data = body.data;
  const media = Array.isArray(data.images) && data.images.length
    ? data.images.slice(0, 4).map((mediaUrl) => ({ url: mediaUrl, extension: 'jpg' }))
    : data.wmplay ? [{ url: data.wmplay, extension: 'mp4' }] : [];
  return { title: data.title || '', media };
}

async function fetchViaAggregator(url) {
  if (!process.env.AUTODOWN_API_URL) throw new Error('Nền tảng này cần cấu hình AUTODOWN_API_URL');
  const endpoint = safeHttpsUrl(process.env.AUTODOWN_API_URL);
  if (!endpoint) throw new Error('AUTODOWN_API_URL phải là HTTPS công khai');
  endpoint.searchParams.set('url', url.toString());
  const headers = {};
  if (process.env.AUTODOWN_API_KEY) headers.authorization = `Bearer ${process.env.AUTODOWN_API_KEY}`;
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`AutoDown provider HTTP ${response.status}`);
  const body = await response.json();
  const result = body.data || body.result || body;
  const items = result.medias || result.attachments || result.media || [];
  const media = items.filter((item) => item?.url).slice(0, 4).map((item) => ({
    url: item.url,
    extension: item.extension || (item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'jpg')
  }));
  if (!media.length) throw new Error('Provider không trả media công khai');
  return { title: result.title || result.caption || '', media };
}

async function downloadAttachment(item, index) {
  const url = safeHttpsUrl(item.url);
  if (!url) throw new Error('Provider trả về URL media không an toàn');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/^(image|audio|video)\//i.test(contentType)) throw new Error('URL không trả về ảnh, audio hoặc video');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_FILE_BYTES) throw new Error('File lớn hơn giới hạn Discord 8 MB');
  if (!response.body) throw new Error('Media không có nội dung');

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) throw new Error('File lớn hơn giới hạn Discord 8 MB');
    chunks.push(chunk);
  }
  const extension = String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  return {
    attachment: new AttachmentBuilder(Buffer.concat(chunks), { name: `autodown-${index + 1}.${extension}` }),
    size
  };
}

function findLink(content) {
  const links = content.match(/https?:\/\/[^\s<>]+/gi) || [];
  return links.map((link) => link.replace(/[),.!?]+$/, '')).find((link) => platformFor(link));
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const settings = db.prepare('SELECT * FROM autodown_settings WHERE guildId = ? AND enabled = 1 AND channelId = ?')
    .get(message.guild.id, message.channelId);
  if (!settings) return;

  const candidate = findLink(message.content || '');
  if (!candidate) return;
  const detected = platformFor(candidate);
  const provider = providers[detected.platform];
  if (!settings[provider.enabledColumn]) return;

  const cooldownKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if ((lastRequest.get(cooldownKey) || 0) > now - USER_COOLDOWN_MS) return;
  lastRequest.set(cooldownKey, now);

  try {
    const result = detected.platform === 'tiktok'
      ? await fetchTikTok(detected.url)
      : await fetchViaAggregator(detected.url);
    const attachments = [];
    let totalBytes = 0;
    for (const item of result.media) {
      try {
        const downloaded = await downloadAttachment(item, attachments.length);
        if (totalBytes + downloaded.size > MAX_FILE_BYTES) break;
        attachments.push(downloaded.attachment);
        totalBytes += downloaded.size;
      }
      catch (error) { console.warn(`AutoDown ${detected.platform}:`, error.message); }
    }
    if (!attachments.length) throw new Error('Không tải được file phù hợp hoặc file vượt giới hạn 8 MB');
    const title = String(result.title || '').replace(/[@`]/g, '').slice(0, 180);
    await message.channel.send({
      content: `[${detected.platform.toUpperCase()}]${title ? ` ${title}` : ''}`,
      files: attachments,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error(`❌ AutoDown ${detected.platform}:`, error.message);
    await message.reply({ content: `Không thể tải link ${detected.platform}: ${error.message}` }).catch(() => {});
  }
}

module.exports = { handleMessage, platformFor, safeHttpsUrl };