'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { MiB, fail, readLimited, decodeBase64, atomicWrite } = require('./common.cjs');
const MAX_IMAGE = 10 * MiB;

async function saveImage(bytes, mediaDir, declaredFormat) {
  // Check the byte signature before sending anything to a raster decoder. Never accept SVG/PDF.
  const format = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg' :
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!format || (declaredFormat && format !== declaredFormat)) fail(415, '图片内容不是声明的 PNG、JPEG 或 WebP。');
  let clean;
  try {
    const pipe = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
    const m = await pipe.metadata();
    if (m.format !== format || (m.pages || 1) > 1 || !m.width || !m.height || m.width * m.height > 20_000_000) throw new Error();
    // Re-encoding discards metadata/trailing data. No SVG, animations or supplied filenames on disk.
    clean = await pipe.rotate().resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 92 }).timeout({seconds: 10}).toBuffer();
  } catch { fail(422, '图片损坏、尺寸过大或不是单帧图片（上限 2000 万像素）。'); }
  const name = createHash('sha256').update(clean).digest('hex') + '.webp';
  await atomicWrite(path.join(mediaDir, name), clean);
  return { src: '/media/' + name };
}
async function uploadImage({dataUrl}, mediaDir) {
  if (typeof dataUrl !== 'string') fail(400, '需要图片 dataUrl。');
  const match = /^data:image\/(png|jpeg|webp);base64,/.exec(dataUrl);
  if (!match) fail(415, '仅支持 PNG、JPEG 和 WebP。');
  return saveImage(decodeBase64(dataUrl.slice(match[0].length), MAX_IMAGE), mediaDir, match[1]);
}
function imageEndpoint(env) {
  let u;
  try { u = new URL(env.OPENAI_IMAGE_ENDPOINT || (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/images/generations'); } catch { fail(503, '图像服务地址无效，请检查服务端环境变量。'); }
  if (u.username || u.password || u.hash || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) fail(503, '图像服务地址必须使用 HTTPS（本机回环 HTTP 除外）。');
  return u;
}
async function generateImage(body, mediaDir, env) {
  if (!env.OPENAI_API_KEY?.trim()) fail(503, '尚未配置 AI 生图。请在服务端设置 OPENAI_API_KEY 并重启；也可直接上传本地图片。');
  for (const [key, max] of [['prompt', 4000], ['style', 240], ['layout', 240], ['text', 6000]]) {
    if ((key === 'prompt' || body[key] != null) && (typeof body[key] !== 'string' || body[key].length > max)) fail(400, `字段 ${key} 格式或长度不正确。`);
  }
  if (body.background != null && !['auto', 'transparent', 'opaque'].includes(body.background)) {
    fail(400, '字段 background 仅支持 auto、transparent 或 opaque。');
  }
  if (!body.prompt.trim()) fail(400, '请填写生图提示词。');
  const prompt = ['为中文图文作品绘制配图，不要添加水印或额外文字。', body.prompt, body.style && `画风：${body.style}`, body.layout && `构图：${body.layout}`, body.text && `文章语境：${body.text}`].filter(Boolean).join('\n');
  const endpoint = imageEndpoint(env);
  // The caller cannot override the endpoint or model. Never follow redirects or URLs in a response.
  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const gptImage = /^gpt-image-/.test(model);
  // Keep custom providers on a basic square request; only GPT Image gets its shape/alpha options.
  const size = gptImage && body.layout === 'inline' ? '1536x1024' : gptImage && body.layout === 'hero' ? '1024x1536' : '1024x1024';
  const transparent = gptImage && (
    body.background === 'transparent' ||
    (body.background !== 'opaque' && /透明背景|去底|transparent background/i.test(body.style || ''))
  );
  let result;
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, prompt, size, n: 1, ...(transparent ? {background: 'transparent', output_format: 'png'} : {}), ...(/^dall-e-/.test(model) ? {response_format: 'b64_json'} : {}) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 || response.status === 403 ? '请检查服务端密钥与模型访问权限。' : response.status === 429 ? '请检查额度或稍后再试。' : '请检查模型、额度或提示词。';
      fail(502, `图像服务返回 ${response.status}；${hint}`);
    }
    result = JSON.parse((await readLimited(response.body, Math.ceil(MAX_IMAGE * 4 / 3) + 65536)).toString('utf8'));
  } catch (e) {
    if (e.httpStatus === 502) throw e;
    fail(502, '图像服务超时、无法连接或响应无效。未自动重试，请先核对服务账单。');
  }
  const b64 = result?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string') fail(502, '图像服务未返回 b64_json 图片数据；不下载响应中的外部 URL。');
  return saveImage(decodeBase64(b64, MAX_IMAGE), mediaDir);
}
module.exports = { uploadImage, generateImage, MAX_IMAGE };
