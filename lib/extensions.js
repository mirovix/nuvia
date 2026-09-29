// Helpers for unpacked Chrome extensions: localized names, icons and URL match patterns.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

export function localize(dir, manifest, value = '') {
  const key = String(value).match(/^__MSG_(.+)__$/)?.[1];
  if (!key) return value;
  for (const locale of ['it', manifest.default_locale, 'en'].filter(Boolean)) {
    const messages = readJson(join(dir, '_locales', locale, 'messages.json'));
    const entry = messages && Object.entries(messages).find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (entry) return entry[1].message;
  }
  return value;
}

export function matchPatterns(manifest) {
  const patterns = new Set();
  for (const script of manifest.content_scripts || []) for (const match of script.matches || []) patterns.add(match);
  for (const match of manifest.host_permissions || []) patterns.add(match);
  if (manifest.manifest_version === 2) for (const permission of manifest.permissions || []) if (/[:*]|<all_urls>/.test(permission)) patterns.add(permission);
  return [...patterns];
}

export function readInfo(dir) {
  const manifest = readJson(join(dir, 'manifest.json'));
  if (!manifest) return null;
  const icons = manifest.icons || manifest.action?.default_icon || manifest.browser_action?.default_icon || {};
  const iconPath = typeof icons === 'string' ? icons : icons[Object.keys(icons).sort((a, b) => Number(b) - Number(a)).find(size => Number(size) <= 128) || Object.keys(icons)[0]];
  const icon = iconPath && existsSync(join(dir, iconPath)) ? join(dir, iconPath) : null;
  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
  return {
    name: localize(dir, manifest, manifest.name) || 'Estensione',
    description: localize(dir, manifest, manifest.description || ''),
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    icon,
    popup,
    matches: matchPatterns(manifest)
  };
}

export function patternMatches(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  const parsed = pattern.match(/^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/);
  if (!parsed) return false;
  let target; try { target = new URL(url); } catch { return false; }
  const [, scheme, host, path = '/*'] = parsed;
  if (scheme === '*' ? !/^https?:$/.test(target.protocol) : `${scheme}:` !== target.protocol) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) { const base = host.slice(2); if (target.hostname !== base && !target.hostname.endsWith(`.${base}`)) return false; }
    else if (target.hostname !== host) return false;
  }
  const regex = new RegExp(`^${path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return regex.test(`${target.pathname}${target.search}`) || regex.test(target.pathname) || path === '/';
}

// Enable a new extension only where it can actually do something.
export function defaultRules(info, services) {
  const rules = {};
  for (const service of services) {
    const relevant = !info.matches.length || info.matches.some(pattern => patternMatches(pattern, service.url));
    rules[service.id] = relevant;
  }
  return rules;
}
