// Functions executed inside service pages via webContents.executeJavaScript.
// They must be self-contained: they are serialized with Function#toString.

export const script = (fn, ...args) => `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`;

export function gmailInbox() {
  const loggedOut = /accounts\.google\.com|workspace\.google\.com/.test(location.href);
  const rows = [...document.querySelectorAll('tr.zA')].slice(0, 40);
  const items = rows.map(row => {
    const sender = row.querySelector('.yW [email], .yW [name], .zF, .yP');
    const thread = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id')
      || row.querySelector('[data-thread-id]')?.getAttribute('data-thread-id')?.replace(/^#?thread-f:/, '') || '';
    return {
      id: thread || row.id,
      rowId: row.id,
      from: sender?.getAttribute('name') || sender?.innerText || '',
      email: sender?.getAttribute('email') || '',
      subject: (row.querySelector('.bog')?.innerText || row.querySelector('.bqe')?.innerText || '').trim(),
      snippet: (row.querySelector('.y2')?.innerText || '').replace(/^\s*[-–]\s*/, '').trim(),
      time: (row.querySelector('.xW span')?.innerText || row.querySelector('.xW')?.innerText || '').trim(),
      fullTime: row.querySelector('.xW span[title]')?.getAttribute('title') || '',
      unread: row.classList.contains('zE')
    };
  });
  const account = location.href.match(/\/mail\/u\/(\d+)/)?.[1] || '0';
  return { loggedOut, url: location.href, account, items, unread: null };
}

export function outlookInbox() {
  const loggedOut = /login\.(?:live|microsoftonline)\.com/.test(location.href);
  const seen = new Set();
  const rows = [...document.querySelectorAll('[data-convid]')].filter(row => {
    const id = row.getAttribute('data-convid');
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  }).slice(0, 40);
  const items = rows.map(row => {
    const label = row.getAttribute('aria-label') || '';
    return { id: row.getAttribute('data-convid'), lines: (row.innerText || '').split('\n'), unread: /^(?:non letto|unread)|\b(?:non letto|unread)\b/i.test(label) };
  });
  const inbox = [...document.querySelectorAll('[role="treeitem"]')].find(node => /posta in arrivo|inbox/i.test(node.getAttribute('title') || node.innerText || ''));
  const unread = Number((inbox?.innerText || '').match(/\n\s*(\d+)\s*$/)?.[1] || (inbox?.innerText || '').match(/(\d+)\s*$/)?.[1] || 0);
  return { loggedOut, url: location.href, items, unread };
}

export function openOutlookItem(id) {
  const row = document.querySelector(`[data-convid="${CSS.escape(id)}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center' });
  for (const type of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  return true;
}

export function openGmailRow(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  return true;
}

export function chatList(kind) {
  const selectors = {
    whatsapp: ['#pane-side [role="listitem"]', '#pane-side [role="row"]', '[data-testid="cell-frame-container"]'],
    telegram: ['.chatlist-chat', '.ListItem.Chat', '.chat-item-clickable'],
    other: ['[role="listitem"]', '[role="row"]']
  }[kind] || ['[role="listitem"]'];
  let rows = [];
  for (const selector of selectors) { rows = [...document.querySelectorAll(selector)]; if (rows.length) break; }
  const loggedOut = kind === 'whatsapp' ? Boolean(document.querySelector('canvas[aria-label], [data-ref] canvas, [data-testid="qrcode"]')) && !document.querySelector('#pane-side')
    : kind === 'telegram' ? Boolean(document.querySelector('.auth-pages, #auth-pages, .qr-container, #auth-qr-form')) : false;
  const seen = new Set(); const items = [];
  for (const row of rows) {
    const text = (row.innerText || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const avatar = [...row.querySelectorAll('img')].map(image => image.currentSrc || image.src).find(src => /^https:|^data:image/.test(src)) || '';
    const badge = row.querySelector('[aria-label*="non lett" i], [aria-label*="unread" i], .badge-unread, .dialog-subtitle-badge-unread, .ChatBadge:not(.muted)');
    items.push({ lines: text.split('\n'), avatar: avatar.length < 4000 ? avatar : '', unread: Number((badge?.innerText || '').replace(/\D/g, '')) || 0 });
    if (items.length >= 25) break;
  }
  return { loggedOut, items, url: location.href };
}

export async function mattermostFeed() {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const get = async path => { const response = await fetch(`/api/v4${path}`, { headers, credentials: 'include' }); if (!response.ok) throw new Error(String(response.status)); return response.json(); };
  let me;
  try { me = await get('/users/me'); } catch { return { loggedOut: true, items: [] }; }
  const users = new Map([[me.id, me]]);
  const user = async id => { if (!users.has(id)) { try { users.set(id, await get(`/users/${id}`)); } catch { users.set(id, { username: 'user' }); } } return users.get(id); };
  const name = person => [person.first_name, person.last_name].filter(Boolean).join(' ') || person.nickname || person.username;
  const items = [];
  for (const team of await get('/users/me/teams')) {
    const [channels, members] = await Promise.all([get(`/users/me/teams/${team.id}/channels`), get(`/users/me/teams/${team.id}/channels/members`)]);
    const memberOf = new Map(members.map(member => [member.channel_id, member]));
    const recent = channels.filter(channel => channel.last_post_at && channel.delete_at === 0).sort((a, b) => b.last_post_at - a.last_post_at).slice(0, 12);
    for (const channel of recent) {
      let title = channel.display_name; let path = `/${team.name}/channels/${channel.name}`;
      if (channel.type === 'D') {
        const other = channel.name.split('__').find(id => id !== me.id) || me.id;
        const person = await user(other); title = name(person); path = `/${team.name}/messages/@${person.username}`;
      }
      let preview = ''; let author = '';
      try {
        const posts = await get(`/channels/${channel.id}/posts?per_page=1`);
        const post = posts.order?.[0] && posts.posts[posts.order[0]];
        if (post) { preview = post.message || (post.file_ids?.length ? 'Attachment' : ''); author = post.user_id === me.id ? 'You' : name(await user(post.user_id)); }
      } catch {}
      const member = memberOf.get(channel.id);
      const unread = member ? Math.max(0, (channel.total_msg_count_root ?? channel.total_msg_count) - (member.msg_count_root ?? member.msg_count)) : 0;
      items.push({ chat: title, channelId: channel.id, path, at: channel.last_post_at, preview: author && channel.type !== 'D' ? `${author}: ${preview}` : preview, unread, team: team.display_name });
    }
  }
  return { loggedOut: false, items };
}

export async function mattermostSend(channelId, message) {
  const token = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/)?.[1] || '';
  const response = await fetch('/api/v4/posts', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token }, body: JSON.stringify({ channel_id: channelId, message }) });
  return { ok: response.ok, message: response.ok ? 'Sent' : `Mattermost replied ${response.status}` };
}

export function openChat(kind, chat) {
  const selectors = { whatsapp: '#pane-side [role="listitem"], #pane-side [role="row"], [data-testid="cell-frame-container"]', telegram: '.chatlist-chat, .ListItem.Chat, .chat-item-clickable' }[kind] || '[role="listitem"]';
  const row = [...document.querySelectorAll(selectors)].find(node => (node.innerText || '').split('\n')[0].trim() === chat);
  if (!row) return false;
  const target = row.querySelector('[role="gridcell"], a, [tabindex]') || row;
  for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  return true;
}

export function sendInOpenChat(kind, chat, text) {
  const header = kind === 'whatsapp' ? document.querySelector('#main header') : document.querySelector('.chat-info .peer-title, .top .peer-title, .ChatInfo .fullName, .MiddleHeader h3');
  if (!header || !(header.innerText || '').includes(chat)) return { ok: false, message: 'Chat not open: message not sent' };
  const box = kind === 'whatsapp' ? document.querySelector('#main footer [contenteditable="true"]') : document.querySelector('.input-message-input[contenteditable="true"], #editable-message-text');
  if (!box) return { ok: false, message: 'Message box not found' };
  box.focus();
  const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
  document.execCommand('insertText', false, text);
  if (!(box.innerText || '').includes(text.slice(0, 20))) return { ok: false, message: 'The service did not accept the text' };
  return new Promise(resolve => setTimeout(() => {
    const send = kind === 'whatsapp'
      ? (document.querySelector('#main footer button[aria-label="Invia"], #main footer button[aria-label="Send"]') || document.querySelector('#main footer [data-icon="send"], #main footer [data-icon="wds-ic-send-filled"]')?.closest('button'))
      : document.querySelector('.btn-send:not(.hide), button.send, .SendButton, button[title="Send Message"]');
    if (!send) return resolve({ ok: false, message: 'Send button not found' });
    send.click();
    resolve({ ok: true, message: 'Sent' });
  }, 250));
}

export function spotifyState() {
  const q = selector => document.querySelector(selector);
  const metadata = navigator.mediaSession?.metadata;
  const widget = q('[data-testid="now-playing-widget"]');
  const range = q('[data-testid="playback-progressbar"] input[type="range"]');
  const volume = q('[data-testid="volume-bar"] input[type="range"]');
  const play = q('[data-testid="control-button-playpause"]');
  const label = (play?.getAttribute('aria-label') || '').toLowerCase();
  const toSeconds = text => (text || '').split(':').reduce((total, part) => total * 60 + Number(part || 0), 0);
  const position = toSeconds(q('[data-testid="playback-position"]')?.innerText);
  const duration = toSeconds(q('[data-testid="playback-duration"]')?.innerText);
  const artwork = [...(metadata?.artwork || [])].sort((a, b) => parseInt(b.sizes || '0', 10) - parseInt(a.sizes || '0', 10))[0]?.src || q('[data-testid="cover-art-image"]')?.src || '';
  const shuffle = q('[data-testid="control-button-shuffle"]');
  const repeat = q('[data-testid="control-button-repeat"]');
  const like = widget?.querySelector('[data-testid="add-button"], button[aria-checked]');
  const loggedOut = Boolean(q('[data-testid="login-button"]')) || /accounts\.spotify\.com/.test(location.href);
  return {
    connected: !loggedOut,
    ready: Boolean(play),
    title: metadata?.title || q('[data-testid="context-item-info-title"]')?.innerText || '',
    artist: metadata?.artist || q('[data-testid="context-item-info-subtitles"]')?.innerText || '',
    album: metadata?.album || '',
    artwork,
    paused: !play || /play|riproduci/.test(label) && !/pausa|pause/.test(label),
    position, duration,
    progress: range ? Number(range.value) / Number(range.max || 1) : (duration ? position / duration : 0),
    volume: volume ? Number(volume.value) / Number(volume.max || 1) : null,
    shuffle: shuffle?.getAttribute('aria-checked') === 'true',
    repeat: repeat?.getAttribute('aria-checked') || 'false',
    liked: like?.getAttribute('aria-checked') === 'true',
    device: q('[data-testid="control-button-npv"]') ? '' : (q('[data-testid="device-picker-icon-button"]')?.getAttribute('aria-label') || ''),
    url: location.href
  };
}

export function spotifyControl(action, value) {
  const q = selector => document.querySelector(selector);
  const buttons = { play: '[data-testid="control-button-playpause"]', next: '[data-testid="control-button-skip-forward"]', previous: '[data-testid="control-button-skip-back"]', shuffle: '[data-testid="control-button-shuffle"]', repeat: '[data-testid="control-button-repeat"]', like: '[data-testid="now-playing-widget"] [data-testid="add-button"], [data-testid="now-playing-widget"] button[aria-checked]' };
  if (buttons[action]) { const button = q(buttons[action]); if (!button) return false; button.click(); return true; }
  const setRange = input => {
    if (!input) return false;
    const min = Number(input.min || 0); const max = Number(input.max || 1);
    const raw = min + (max - min) * Math.min(1, Math.max(0, value));
    // Progress bars use milliseconds, the volume bar is 0..1: only round the former.
    const next = max - min > 10 ? Math.round(raw) : Number(raw.toFixed(3));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  if (action === 'seek') return setRange(q('[data-testid="playback-progressbar"] input[type="range"]'));
  if (action === 'volume') return setRange(q('[data-testid="volume-bar"] input[type="range"]'));
  return false;
}

export function spotifyLibrary() {
  const rows = [...document.querySelectorAll('#Desktop_LeftSidebar_Id [role="row"], [data-testid="rootlist-item"], nav [role="listitem"]')];
  const seen = new Set(); const items = [];
  for (const row of rows) {
    const labelled = [row, ...row.querySelectorAll('[aria-labelledby]')].map(node => node.getAttribute('aria-labelledby') || '').join(' ');
    const uri = labelled.match(/spotify:(?:playlist|album|artist|show|collection|user)(?::[\w-]+)+/)?.[0] || row.querySelector('a[href^="/playlist/"], a[href^="/album/"], a[href^="/artist/"], a[href^="/collection/"]')?.getAttribute('href') || '';
    const name = row.querySelector('[data-encore-id="listRowTitle"], [data-encore-id="text"]')?.innerText || (row.innerText || '').split('\n')[0];
    if (!uri || seen.has(uri) || !name) continue;
    seen.add(uri);
    const subtitle = row.querySelector('[data-encore-id="listRowSubtitle"]')?.innerText || (row.innerText || '').split('\n').slice(1).join(' · ');
    items.push({ uri, name: name.trim(), subtitle: subtitle.trim(), image: row.querySelector('img')?.src || '' });
    if (items.length >= 40) break;
  }
  return items;
}

export function spotifyTracks() {
  return [...document.querySelectorAll('[data-testid="tracklist-row"]')].slice(0, 20).map((row, index) => ({
    index,
    title: row.querySelector('[data-testid="internal-track-link"] div, a[href^="/track/"] div, a[href^="/track/"]')?.innerText || (row.innerText || '').split('\n')[1] || '',
    artist: [...row.querySelectorAll('a[href^="/artist/"]')].map(link => link.innerText).join(', '),
    image: row.querySelector('img')?.src || '',
    duration: [...row.querySelectorAll('div')].map(node => node.innerText).reverse().find(text => /^\d+:\d{2}$/.test(text || '')) || ''
  })).filter(track => track.title);
}

export function spotifyPlayTrack(index) {
  const row = document.querySelectorAll('[data-testid="tracklist-row"]')[index];
  if (!row) return false;
  const button = row.querySelector('button[aria-label^="Play"], button[aria-label^="Riproduci"], [data-testid="play-button"]');
  if (button) { button.click(); return true; }
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  return true;
}

export function spotifyPlayContext() {
  const button = document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"], [data-testid="action-bar"] [data-testid="play-button"]');
  if (!button) return false;
  const label = (button.getAttribute('aria-label') || '').toLowerCase();
  if (!/pausa|pause/.test(label)) button.click();
  return true;
}

export async function claudeLimits() {
  try {
    const orgsResponse = await fetch('/api/organizations', { credentials: 'include' });
    if (!orgsResponse.ok) return { loggedOut: orgsResponse.status === 401 || orgsResponse.status === 403, status: orgsResponse.status };
    const orgs = await orgsResponse.json();
    const org = orgs.find(item => (item.capabilities || []).includes('chat')) || orgs[0];
    if (!org) return { loggedOut: true };
    const usage = await (await fetch(`/api/organizations/${org.uuid}/usage`, { credentials: 'include' })).json();
    return { usage, plan: org.rate_limit_tier || '', capabilities: org.capabilities || [] };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

export function pageText() {
  return { text: document.querySelector('main')?.innerText || document.body?.innerText || '', url: location.href };
}

export function agendaText() {
  const nodes = [...document.querySelectorAll('[data-eventid], [data-eventchip], [data-calitemid], [role="main"] [role="button"][aria-label]')];
  const ignored = /^(?:crea|create|oggi|today|precedente|successivo|previous|next|menu|impostazioni|settings)/i;
  const seen = new Set(); const items = [];
  for (const node of nodes) {
    const text = (node.getAttribute('aria-label') || node.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 400 || ignored.test(text) || seen.has(text)) continue;
    seen.add(text); items.push(text);
    if (items.length >= 60) break;
  }
  return { items, url: location.href };
}
