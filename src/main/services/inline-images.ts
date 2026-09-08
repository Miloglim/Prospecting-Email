// ── 发信 HTML 内联图片归一（签名/正文图片不再发出去变裂图）────────────────
// 问题：邮件客户端（Gmail/Outlook 等）会过滤 data: 内联图，且签名里的
//   file:///、局域网 http://、Word/Outlook 粘贴带来的 cid: 引用、相对路径，
//   收件人端全都读不到 —— 这就是「签名图片失效」的根因。
// 做法：发信前把**能取到内容**的图片（data / file / http）统一转成 CID 内嵌附件；
//   取不到内容的（cid: 悬空引用、无 base 的相对路径）如实上报，由界面提示用户重新粘贴图片。
// 纯函数 + 注入 loader：不碰 fs/net，便于单测；真实 loader 在 send.ipc 里给。
export type ImageLoader = (src: string) => Promise<{ buffer: Buffer; ext: string } | null>;

export interface EmbedOptions {
  /** 最多内嵌几张（签名+正文），超出保留原样 */
  maxImages?: number;
  /** 单张字节上限 */
  maxBytesPerImage?: number;
}

export interface EmbedResult {
  html: string;
  attachments: Array<{ filename: string; content: Buffer; cid: string }>;
  /** 没能内嵌、且收件人大概率看不到图的引用（给日志/界面用） */
  unresolved: string[];
  converted: number;
}

const DEFAULTS: Required<EmbedOptions> = { maxImages: 8, maxBytesPerImage: 4 * 1024 * 1024 };

/** src/background 属性值（双引号、单引号都认；无引号的 HTML 属性在邮件签名里几乎不出现，不折腾） */
const ATTR_RE = /\b(src|background)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** style="background:url(...)" / url('...') */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;
const DATA_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
/** 引用分类：data（本函数解码）/ fetch（loader 取：file、http、绝对路径）/ dead（救不回来） */
type RefKind = "data" | "fetch" | "dead";
function classify(src: string): RefKind {
  const s = src.trim();
  if (/^data:image\//i.test(s)) return "data";
  if (/^https?:\/\//i.test(s) || /^file:/i.test(s)) return "fetch";
  if (/^[a-z]:[\\/]/i.test(s) || s.startsWith("/") || s.startsWith("\\\\")) return "fetch";   // 本地绝对路径（签名里常见）
  return "dead";                                  // cid: 悬空引用、相对路径、//host 等：发信端无从恢复
}

function extFromMimeOrUrl(mime: string | null, url: string): string {
  const byMime = (mime ?? "").toLowerCase();
  if (byMime.includes("png")) return "png";
  if (byMime.includes("jpeg") || byMime.includes("jpg")) return "jpg";
  if (byMime.includes("gif")) return "gif";
  if (byMime.includes("webp")) return "webp";
  const m = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.exec(url);
  const e = m?.[1]?.toLowerCase();
  if (!e) return "png";
  return e === "jpeg" ? "jpg" : e;
}

function decodeDataUrl(src: string): { buffer: Buffer; ext: string } | null {
  const m = DATA_RE.exec(src.replace(/\s+/g, ""));
  if (!m?.[1] || !m[2]) return null;
  try {
    return { buffer: Buffer.from(m[2], "base64"), ext: extFromMimeOrUrl(m[1], "") };
  } catch { return null; }
}

/** 收集 HTML 里所有图片引用（属性 + CSS url），保持出现顺序去重 */
function collectRefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string | undefined) => {
    const s = (v ?? "").trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  for (const m of html.matchAll(ATTR_RE)) push(m[2] ?? m[3]);
  for (const m of html.matchAll(CSS_URL_RE)) push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * 把可取到内容的图片转成 CID 内嵌附件，并改写 HTML 引用。
 * loader 决定 file/http 能否取到；data: 在本函数内解码。同一个 src 多处引用共用一个附件。
 */
export async function embedInlineImages(
  html: string, load: ImageLoader, opts: EmbedOptions = {},
): Promise<EmbedResult> {
  const o = { ...DEFAULTS, ...opts };
  const refs = collectRefs(html);
  const map = new Map<string, string>();          // src → cid:xxx
  const attachments: EmbedResult["attachments"] = [];
  const unresolved: string[] = [];
  let idx = 0;

  for (const src of refs) {
    const kind = classify(src);
    if (kind === "dead") { unresolved.push(src); continue; }            // 悬空 cid:/相对路径：只上报，不猜
    if (attachments.length >= o.maxImages) { unresolved.push(src); continue; }
    const got = kind === "data" ? decodeDataUrl(src) : await load(src);
    if (!got || !got.buffer?.length) { unresolved.push(src); continue; }
    if (got.buffer.length > o.maxBytesPerImage) { unresolved.push(src); continue; }
    const cid = `img${idx}@prospector`;
    idx++;
    attachments.push({ filename: `img${idx - 1}.${got.ext}`, content: got.buffer, cid });
    map.set(src, `cid:${cid}`);
  }

  let out = html;
  for (const [src, cid] of map) {
    // 只替换 src/background 属性与 url() 里的精确匹配值，别误伤同名文本
    out = out.replace(new RegExp(`((?:\\bsrc|\\bbackground)\\s*=\\s*["'])${escapeReg(src)}(["'])`, "gi"), `$1${cid}$2`);
    out = out.replace(new RegExp(`(url\\(\\s*["']?)${escapeReg(src)}(["']?\\s*\\))`, "gi"), `$1${cid}$2`);
  }
  return { html: out, attachments, unresolved, converted: attachments.length };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 签名/正文里收件人必然看不到、发信端也救不回来的引用（保存时提示用户重新粘贴图片） */
export function deadImageRefs(html: string): string[] {
  return collectRefs(html).filter(s => /^(cid:|blob:|about:)/i.test(s)
    || (/^(https?:|data:|file:|\/)/i.test(s) === false && /\.[a-z]{2,6}$/i.test(s.split(/[?#]/)[0] ?? "")));
}
