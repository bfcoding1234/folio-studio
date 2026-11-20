export const ASSET_PATH_RE = /^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp)$/i;
export const MEDIA_PATH_RE = /^\/media\/[a-f0-9]{64}\.webp$/;

export function isLocalImageURL(src) {
  return typeof src === 'string' && (ASSET_PATH_RE.test(src) || MEDIA_PATH_RE.test(src));
}

export function sanitizeCoverURL(src) {
  return isLocalImageURL(src) ? src : '';
}

export async function api(url, method = 'GET', body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    let error;
    try {
      error = (await res.json()).error;
    } catch {}
    throw Object.assign(Error(typeof error === 'string' ? error : `请求失败（${res.status}）`), {
      status: res.status
    });
  }
  return res;
}

export async function uploadImageFile(file) {
  if (!file) throw Error('没有选择图片');
  if (file.size > 10 * 1024 * 1024) throw Error('图片超过 10 MB，请先压缩');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  const { src } = await (await api('/api/upload', 'POST', { dataUrl })).json();
  if (!isLocalImageURL(src)) throw Error('本地图片地址无效');
  return { src, name: file.name, origin: '上传' };
}
