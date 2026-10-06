// The status line script Nuvia installs for Claude Code. Claude Code runs it with
// a JSON payload on stdin; the script saves the plan limits for Nuvia and prints
// a short line for the terminal ("5h 23% · 7d 41%").
//
// Kept dependency-free and written out as a plain file (claudeStatusLineScript)
// because Claude Code starts it with the user's node, outside Nuvia.
export function claudeStatusLineScript(limitsFile) {
  return `#!/usr/bin/env node
// Written by Nuvia: saves Claude Code's plan limits for the Claude & Codex widget.
const { writeFileSync, renameSync } = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch {}
  const limits = data.rate_limits;
  if (limits && typeof limits === 'object') {
    const file = ${JSON.stringify(limitsFile)};
    try {
      writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), model: data.model?.id || null, rate_limits: limits }), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    } catch {}
  }
  const part = (label, window) => window && typeof window.used_percentage === 'number' ? label + ' ' + Math.round(window.used_percentage) + '%' : '';
  const text = [data.model?.display_name || '', part('5h', limits?.five_hour), part('7d', limits?.seven_day)].filter(Boolean).join(' · ');
  process.stdout.write(text);
});
`;
}

/**
 * settings.json with Nuvia's status line added. Returns null when the user
 * already has a status line of their own: Nuvia never replaces it.
 */
export function withNuviaStatusLine(settings, scriptPath) {
  const current = settings?.statusLine;
  const command = `node ${JSON.stringify(scriptPath)}`;
  if (current && current.command !== command) return null;
  return { ...settings, statusLine: { type: 'command', command, padding: 0 } };
}
