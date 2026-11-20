'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MiB = 1024 * 1024;
function fail(status, message) { const error = new Error(message); error.httpStatus = status; throw error; }

async function readLimited(stream, max) {
  const chunks = []; let n = 0;
  for await (const chunk of stream) {
    n += chunk.length;
    if (n > max) fail(413, '数据超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, n);
}
async function readJSON(req, max) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(415, '请使用 application/json。');
  if (Number(req.headers['content-length']) > max) fail(413, '请求超过大小限制。');
  const bytes = await readLimited(req, max);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'JSON 格式不正确。'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, '需要 JSON 对象。');
  return value;
}
function decodeBase64(s, max) {
  if (typeof s !== 'string' || !s.length || s.length > Math.ceil(max / 3) * 4 || s.length % 4 || /[^A-Za-z0-9+/=]/.test(s) || !/^[^=]*={0,2}$/.test(s)) fail(400, '图片编码或大小不正确。');
  const bytes = Buffer.from(s, 'base64');
  if (bytes.length > max) fail(413, '图片过大。');
  return bytes;
}
async function atomicWrite(file, bytes) {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
// Only regular files physically within the declared tree, never hidden path segments.
async function safeRead(root, relative, max) {
  if (relative.split('/').some(s => !s || s.startsWith('.') || /[\\:\u0000-\u001f]/.test(s))) fail(404, '资源不存在。');
  let target, realRoot;
  try { [realRoot, target] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, relative))]); }
  catch { fail(404, '资源不存在。'); }
  if (!target.startsWith(realRoot + path.sep)) fail(404, '资源不存在。');
  const file = await fs.open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail(404, '资源不存在。');
    if (stat.size > max) fail(413, '资源过大。');
    return await file.readFile();
  } finally { await file.close(); }
}
module.exports = { MiB, fail, readLimited, readJSON, decodeBase64, atomicWrite, safeRead };
