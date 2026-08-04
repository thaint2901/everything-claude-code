#!/usr/bin/env node
/**
 * Telegram Notification Hook.
 *
 * Credentials: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID via env only.
 * Set them in ~/.claude/settings.json `env` block (Claude Code injects them
 * into hook subprocesses). See: code.claude.com/docs/en/env-vars
 *
 * Summary resolution order:
 *   1. input.last_assistant_message            (Stop event)
 *   2. transcript_path -> last assistant text  (Notification, idle case)
 *   3. input.message                           (Notification, tool-block case)
 *   4. default fallback string
 */
'use strict';

const https = require('https');
const fs = require('fs');

const MAX_BODY_LENGTH = 100;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const CONFIG = loadConfig();

function loadConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) return { token, chatId };
  return null;
}

function readTranscriptTail(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= MAX_TRANSCRIPT_BYTES) {
      return fs.readFileSync(transcriptPath, 'utf8');
    }
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
      fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return null;
  const content = readTranscriptTail(transcriptPath);
  if (!content) return null;

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'user' &&
        entry.message && typeof entry.message.content === 'string') {
      return null;
    }
    if (entry.type !== 'assistant') continue;
    if (!entry.message || !Array.isArray(entry.message.content)) continue;

    const blocks = entry.message.content;
    if (blocks.some(c => c && c.type === 'tool_use')) return null;

    const texts = blocks
      .filter(c => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim())
      .map(c => c.text.trim());
    if (texts.length) return texts.join('\n');
  }
  return null;
}

function extractSummary(message) {
  if (!message || typeof message !== 'string') return 'Done';
  const firstLine = message.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!firstLine) return 'Done';
  return firstLine.length > MAX_BODY_LENGTH
    ? `${firstLine.slice(0, MAX_BODY_LENGTH)}...`
    : firstLine;
}

function sendTelegram(text) {
  if (!CONFIG) return;
  const payload = JSON.stringify({
    chat_id: CONFIG.chatId,
    text,
    disable_web_page_preview: true,
  });
  const req = https.request(
    {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${CONFIG.token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    res => {
      res.on('data', () => {});
      res.on('end', () => {});
    },
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();
  if (typeof req.unref === 'function') req.unref();
}

function resolveSummary(input) {
  return (
    input.last_assistant_message ||
    readLastAssistantText(input.transcript_path) ||
    input.message ||
    'Claude Code needs your attention'
  );
}

function run(raw) {
  try {
    const input = raw && raw.trim() ? JSON.parse(raw) : {};
    sendTelegram(extractSummary(resolveSummary(input)));
  } catch {
    // best-effort notification — never let a parse/send failure block the hook
  }
  return raw;
}

module.exports = { run };

if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) {
      data += chunk.substring(0, MAX_STDIN - data.length);
    }
  });
  process.stdin.on('end', () => {
    const out = run(data);
    if (out) process.stdout.write(out);
  });
}
