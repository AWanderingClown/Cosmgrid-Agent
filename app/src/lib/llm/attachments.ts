// 对话附件：拖拽/粘贴进来的文件与图片的处理
//
// 设计：
// - 纯函数（classifyFile / toUserCoreMessage）可单测，不碰 DOM/i18n
// - ingestFile 走浏览器 FileReader / file.text()，不依赖 Tauri（拖拽的是浏览器 File 对象）
// - 图片走多模态 image part（base64 dataURL），文本文件读内容贴进 prompt，其它不支持

/** 图片附件：存 base64 dataURL，发多模态 part 直接用 */
interface ImageAttachment {
  id: string;
  kind: "image";
  name: string;
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  dataUrl: string;
}

/** 文本文件附件：正文已读出（≤20KB）；tooLarge 时不读、不贴正文只提示 */
interface TextFileAttachment {
  id: string;
  kind: "text-file";
  name: string;
  mediaType: string;
  size: number;
  text: string; // ≤20KB 才有值；tooLarge 时为空
  tooLarge?: boolean;
}

interface FolderAttachment {
  id: string;
  kind: "folder";
  name: string;
  path: string;
}

export type Attachment = ImageAttachment | TextFileAttachment | FolderAttachment;

/** 大小阈值 */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20MB（对齐多数模型 API 单图上限；图片 token 按分辨率算不按字节，base64 传输大但本地无碍）
const TEXT_FILE_MAX_BYTES = 200 * 1024; // 200KB（约 50k token，多数模型上下文够用；更大的文件提示放进工作区让 AI 用 read 工具读）

/** 可直接贴进 prompt 的文本类扩展名（小写，不含点） */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "md", "markdown", "txt",
  "json", "json5", "css", "scss", "html", "htm", "yml", "yaml", "sh", "bash",
  "rs", "go", "java", "kt", "c", "cpp", "cc", "h", "hpp", "rb", "php", "sql",
  "toml", "ini", "cfg", "conf", "env", "xml", "svg", "vue", "svelte", "astro",
  "lua", "r", "swift", "dart", "gradle", "makefile", "dockerfile",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** 嗅探字节是不是文本：前 8KB 有无 NUL 字节（二进制几乎必有、纯文本几乎必无，git 同款启发式）。
 *  让任意配置/脚本文件（.properties / .command / Makefile / 无扩展名等）都能当文本读，不靠扩展名白名单。 */
const TEXT_SNIFF_MAX_BYTES = 8 * 1024 * 1024; // 超过 8MB 的未知文件不嗅探，按二进制（避免把大 zip/视频读进内存）
function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

/** 分类文件：图片 / 文本文件 / 不支持（PDF/zip/二进制等）。纯函数，可单测。 */
export function classifyFile(file: { name: string; type: string }): "image" | "text-file" | "unsupported" {
  const ext = extOf(file.name);
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text-file";
  return "unsupported";
}

/** 多模态 user 消息的 content part */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string };

export interface UserCoreMessage {
  role: "user";
  content: string | UserContentPart[];
}

/**
 * 把一条 user 消息的文字 + 附件拼成多模态 CoreMessage。
 * - 无附件 → content 为纯 string（省 token）
 * - 有 text-file（非 tooLarge）→ 正文以 ```文件名\n{text}\n``` 追加进 text
 * - 有 image → content 变数组：先 text part（非空才塞），再每个 image 一个 part
 * - tooLarge text-file → 不拼正文，调 tooLargeNotice 注入提示（默认中性英文，调用方可注入 i18n）
 *
 * 纯函数，可单测。
 */
export function toUserCoreMessage(
  text: string,
  attachments: Attachment[] = [],
  opts: { tooLargeNotice?: (name: string) => string } = {},
): UserCoreMessage {
  const tooLargeNotice =
    opts.tooLargeNotice ?? ((n) => `[file ${n} too large, put it in workspace for AI to read]`);

  let combinedText = text;
  const images: ImageAttachment[] = [];

  for (const a of attachments) {
    if (a.kind === "text-file") {
      if (a.tooLarge) {
        combinedText += `\n\n${tooLargeNotice(a.name)}`;
      } else if (a.text) {
        combinedText += `\n\n\`\`\`${a.name}\n${a.text}\n\`\`\``;
      }
    } else if (a.kind === "folder") {
      combinedText += `\n\n（工作文件夹：${a.name}，路径：${a.path}。请用工具读取其中的文件）`;
    } else {
      images.push(a);
    }
  }

  if (images.length === 0) {
    return { role: "user", content: combinedText };
  }
  const parts: UserContentPart[] = [];
  if (combinedText.trim() !== "") {
    parts.push({ type: "text", text: combinedText });
  }
  for (const img of images) {
    parts.push({ type: "image", image: img.dataUrl, mediaType: img.mediaType });
  }
  return { role: "user", content: parts };
}

/**
 * 读取一个 File 为附件。图片读 dataURL，文本读内容；超限拒绝或标 tooLarge。
 * 走浏览器 API（FileReader / file.text()），不依赖 Tauri。
 */
export async function ingestFile(file: File): Promise<Attachment | { error: "unsupported" | "image-too-large" }> {
  const ext = extOf(file.name);
  if (ext === "pdf" || ext === "docx") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return ingestDocumentBytes(bytes, file.name, ext);
  }
  const kind = classifyFile(file);
  const id = crypto.randomUUID();

  // 未知扩展名：读内容嗅探，是文本就收（与 ingestPath 一致，不靠白名单当门卫）。
  if (kind === "unsupported") {
    if (file.size > TEXT_SNIFF_MAX_BYTES) return { error: "unsupported" };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return { error: "unsupported" };
    }
    if (!looksLikeText(bytes)) return { error: "unsupported" };
    const tooLargeSniffed = bytes.byteLength > TEXT_FILE_MAX_BYTES;
    const sniffedText = tooLargeSniffed ? "" : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      id,
      kind: "text-file",
      name: file.name,
      mediaType: file.type || "text/plain",
      size: file.size,
      text: sniffedText,
      ...(tooLargeSniffed ? { tooLarge: true } : {}),
    };
  }

  if (kind === "image") {
    if (file.size > IMAGE_MAX_BYTES) {
      return { error: "image-too-large" };
    }
    const dataUrl = await readAsDataURL(file);
    return {
      id,
      kind: "image",
      name: file.name,
      mediaType: file.type || "image/png",
      dataUrl,
    };
  }
  // text-file
  const tooLarge = file.size > TEXT_FILE_MAX_BYTES;
  let textContent = "";
  if (!tooLarge) {
    try {
      textContent = await file.text();
    } catch {
      textContent = "";
    }
  }
  return {
    id,
    kind: "text-file",
    name: file.name,
    mediaType: file.type || "text/plain",
    size: file.size,
    text: textContent,
    ...(tooLarge ? { tooLarge: true } : {}),
  };
}

/** 安全解析 attachments JSON 列（坏数据返回空数组，绝不抛错） */
export function parseAttachments(json: string | null | undefined): Attachment[] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json) as unknown;
    if (!Array.isArray(obj)) return [];
    return obj as Attachment[];
  } catch {
    return [];
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes], { type: mime });
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

function mediaTypeFromName(name: string): string {
  const ext = extOf(name);
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

/**
 * 从磁盘路径读取附件（Tauri 拖拽场景：tauri://drag-drop 给的是路径，不是 File 对象）。
 * 动态 import plugin-fs，避免模块加载时依赖 Tauri 运行时（保住纯函数单测）。
 * - 文件夹 → { folder: true }（调用方设为工作区）
 * - 图片 → readFile bytes → dataUrl
 * - 文本 → readTextFile（超阈值标 tooLarge）
 * - PDF/Word 等 → { error: "unsupported" }（pdfjs/mammoth 未装时）
 */
export async function ingestPath(
  path: string,
): Promise<Attachment | { error: "unsupported" | "image-too-large" | "read-failed" }> {
  const { stat, readFile, readTextFile, readDir } = await import("@tauri-apps/plugin-fs");
  const name = path.split(/[\\/]/).pop() ?? path;
  let info;
  try {
    info = await stat(path);
  } catch {
    // stat 失败：可能是文件夹（readDir 试得出）或路径不可访问
    try {
      await readDir(path);
      return { id: crypto.randomUUID(), kind: "folder", name, path };
    } catch {
      return { error: "read-failed" };
    }
  }
  if (info.isDirectory) return { id: crypto.randomUUID(), kind: "folder", name, path };
  if (!info.isFile) return { error: "unsupported" };

  const ext = extOf(name);
  if (ext === "pdf" || ext === "docx") {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      return { error: "read-failed" };
    }
    return ingestDocumentBytes(bytes, name, ext);
  }
  const id = crypto.randomUUID();
  const kind = classifyFile({ name, type: "" });
  const size = typeof info.size === "number" ? info.size : 0;

  if (kind === "image") {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      return { error: "read-failed" };
    }
    if (bytes.byteLength > IMAGE_MAX_BYTES) return { error: "image-too-large" };
    const mediaType = mediaTypeFromName(name);
    const dataUrl = await bytesToDataUrl(bytes, mediaType);
    return { id, kind: "image", name, mediaType, dataUrl };
  }

  // 未知扩展名（.properties / .command / Makefile / 无扩展名脚本等）：不靠白名单当门卫，
  // 读内容嗅探——是文本就当 text-file 收，真二进制（zip/exe/未支持图等）才拒。
  if (kind === "unsupported") {
    if (size > TEXT_SNIFF_MAX_BYTES) return { error: "unsupported" };
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      return { error: "read-failed" };
    }
    if (!looksLikeText(bytes)) return { error: "unsupported" };
    const tooLargeSniffed = bytes.byteLength > TEXT_FILE_MAX_BYTES;
    const sniffedText = tooLargeSniffed ? "" : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      id,
      kind: "text-file",
      name,
      mediaType: "text/plain",
      size: bytes.byteLength,
      text: sniffedText,
      ...(tooLargeSniffed ? { tooLarge: true } : {}),
    };
  }

  // text-file（已知文本扩展名）
  const tooLarge = size > TEXT_FILE_MAX_BYTES;
  let text = "";
  if (!tooLarge) {
    try {
      text = await readTextFile(path);
    } catch {
      text = "";
    }
  }
  return {
    id,
    kind: "text-file",
    name,
    mediaType: "text/plain",
    size,
    text,
    ...(tooLarge ? { tooLarge: true } : {}),
  };
}

// PDF 文字提取（pdfjs-dist 4，worker 用 ?url 让 Vite 打包成单独 chunk）
let pdfjsWorkerSet = false;
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs: typeof import("pdfjs-dist") = await import("pdfjs-dist");
  if (!pdfjsWorkerSet) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfjsWorkerSet = true;
  }
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n\n";
  }
  try {
    await doc.destroy();
  } catch {
    /* ignore */
  }
  return text.trim();
}

// Word .docx 文字提取（mammoth）
async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const mod = await import("mammoth");
  const fn = (mod as { extractRawText?: (args: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> })
    .extractRawText ?? (mod as { default?: { extractRawText?: (args: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> } }).default?.extractRawText;
  if (!fn) throw new Error("mammoth extractRawText not found");
  const result = await fn({ arrayBuffer: bytes.buffer as ArrayBuffer });
  return result.value || "";
}

/** PDF / Word 共用：bytes → 提取文字 → text-file 附件 */
async function ingestDocumentBytes(
  bytes: Uint8Array,
  name: string,
  ext: string,
): Promise<Attachment | { error: "unsupported" }> {
  let text = "";
  try {
    text = ext === "pdf" ? await extractPdfText(bytes) : await extractDocxText(bytes);
  } catch {
    return { error: "unsupported" }; // 提取失败（worker 加载/解析错）→ 当不支持，提示用户换文件或转格式
  }
  if (!text.trim()) return { error: "unsupported" }; // 提取不到文字（扫描版 PDF / 空 docx）
  const tooLarge = text.length > TEXT_FILE_MAX_BYTES;
  return {
    id: crypto.randomUUID(),
    kind: "text-file",
    name,
    mediaType: ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: bytes.byteLength,
    text: tooLarge ? "" : text,
    ...(tooLarge ? { tooLarge: true } : {}),
  };
}
