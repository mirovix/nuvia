// Shared by the main process and the renderer (loaded as a plain ES module).

export function serviceKind(service = {}) {
  const url = String(service.url || '').toLowerCase();
  const name = String(service.name || '').toLowerCase();
  if (/mail\.google\.com/.test(url)) return 'gmail';
  if (/outlook\.(?:live|office|office365)\.com/.test(url) && !/calendar/.test(url)) return 'outlook';
  if (/calendar\.google\.com|outlook\.[a-z.]+\/calendar/.test(url)) return 'calendar';
  if (/web\.whatsapp\.com/.test(url)) return 'whatsapp';
  if (/web\.telegram\.org/.test(url)) return 'telegram';
  if (/mattermost/.test(url) || /mattermost/.test(name)) return 'mattermost';
  if (/open\.spotify\.com/.test(url)) return 'spotify';
  if (/notion\.(?:so|site)/.test(url)) return 'notion';
  if (/claude\.ai/.test(url)) return 'claude';
  if (/chatgpt\.com\/codex|chatgpt\.com/.test(url)) return 'codex';
  if (/slack\.com/.test(url)) return 'slack';
  if (/deilabs\.dei\.unipd\.it/.test(url)) return 'ias';
  return 'web';
}

export function serviceGroup(service) {
  const kind = serviceKind(service);
  if (kind === 'gmail' || kind === 'outlook') return 'mail';
  if (['whatsapp', 'telegram', 'mattermost', 'slack'].includes(kind)) return 'message';
  if (kind === 'spotify') return 'music';
  if (kind === 'claude' || kind === 'codex') return 'ai';
  return kind;
}

export const PRESETS = [
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Outlook', url: 'https://outlook.live.com/mail/0/' },
  { name: 'Google Calendar', url: 'https://calendar.google.com/' },
  { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { name: 'Telegram', url: 'https://web.telegram.org/k/' },
  { name: 'Mattermost', url: 'https://mattermost.com/' },
  { name: 'Spotify', url: 'https://open.spotify.com/' },
  { name: 'Notion', url: 'https://www.notion.so/' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'Codex', url: 'https://chatgpt.com/codex' },
  { name: 'Slack', url: 'https://app.slack.com/client' },
  { name: 'IAS Lab', url: 'https://deilabs.dei.unipd.it/home' }
];
