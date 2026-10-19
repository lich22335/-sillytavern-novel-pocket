/** Pure functions used by Novel Pocket; no SillyTavern dependency. */
const CHAPTER_TITLE = /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节卷篇]|chapter\s+\d+|序章|楔子|尾声|终章|番外(?:篇)?)(?:[^\r\n]{0,70})?$/iu;
export const CHUNK_VERSION = 2;
const STOP_TOKENS = new Set(['继续', '接着', '然后', '一下', '这个', '那个', '什么', '怎么', '不是', '就是', '我们', '他们', '她们', '你们', '现在', '这里', '那里', '可以', '应该', '故事', '小说', '剧情', '发生', '一下', '一下', '描述', '场景', '开始', '当前', '有关', '的话', '来说']);

export function parseChapters(text) {
    const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const chapters = [];
    let currentTitle = '正文';
    let parts = [];
    const flush = () => {
        const content = parts.join('\n').trim();
        if (content) chapters.push({ title: currentTitle, text: content });
        parts = [];
    };
    for (const line of lines) {
        const title = line.trim();
        if (title.length > 0 && title.length <= 90 && CHAPTER_TITLE.test(title.replace(/^#{1,6}\s*/, '').replace(/^[【\[]|[】\]]$/g, ''))) {
            flush();
            currentTitle = title;
        } else {
            parts.push(line);
        }
    }
    flush();
    return chapters.length ? chapters : [{ title: '全文', text: source }];
}

/** Prefer one whole chapter; only oversized chapters fall back to whole paragraphs. */
export function chunkBook(text, options = {}) {
    const sourceText = String(text ?? '');
    const chapterLimit = Math.max(100, Number(options.chapterLimit) || 12000);
    const paragraphTarget = Math.min(chapterLimit, Math.max(100, Number(options.paragraphTarget) || 6000));
    const chapters = parseChapters(sourceText);
    const chunks = [];
    for (let chapter = 0; chapter < chapters.length; chapter++) {
        const raw = chapters[chapter].text;
        const pieces = [];
        if (raw.length <= chapterLimit) pieces.push(raw);
        else {
            // A newline is the smallest permitted cut. Never split a paragraph or add overlap.
            const paragraphs = raw.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
            let group = '';
            for (const paragraph of paragraphs) {
                if (group.trim() && group.length + paragraph.length > paragraphTarget) {
                    pieces.push(group.trim()); group = '';
                }
                group += paragraph;
            }
            if (group.trim()) pieces.push(group.trim());
        }
        for (let section = 0; section < pieces.length; section++) {
            chunks.push({ chapter, part: chunks.length, section: section + 1, sections: pieces.length, text: pieces[section], unit: pieces.length === 1 ? 'chapter' : 'paragraphs' });
        }
    }
    return {
        chapters: chapters.map((entry, i) => ({ id: i, title: entry.title })),
        chunks, charCount: sourceText.length, sourceText, chunkVersion: CHUNK_VERSION,
    };
}

/** Rebuild from the real source only. Legacy overlapped blocks cannot reliably recover it. */
export function rebuildBook(book, bindings = {}, sourceText = book.sourceText) {
    if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('旧版没有保存完整原文，请重新选择原始 TXT 更新分段');
    const rebuilt = { ...book, ...chunkBook(sourceText), updatedAt: Date.now() };
    const nextBindings = { ...bindings };
    const clean = value => String(value || '').replace(/\s+/g, '');
    const contents = rebuilt.chunks.map(c => clean(c.text));
    for (const [key, binding] of Object.entries(bindings)) {
        if (binding.bookId !== book.id) continue;
        const oldIndex = Number.isInteger(binding.cursor) ? Math.max(0, Math.min(book.chunks.length - 1, binding.cursor)) : Math.max(0, book.chunks.findIndex(c => c.chapter === binding.chapter));
        const oldChunk = book.chunks[oldIndex];
        const quote = clean(oldChunk?.text).slice(0, 100);
        const oldTitle = book.chapters[oldChunk?.chapter]?.title;
        const sameChapter = rebuilt.chapters.findIndex(c => c.title === oldTitle);
        let index = quote ? rebuilt.chunks.findIndex((c,i) => (sameChapter < 0 || c.chapter === sameChapter) && contents[i].includes(quote)) : -1;
        if (index < 0 && quote) index = contents.findIndex(text => text.includes(quote));
        if (index < 0) index = Math.max(0, rebuilt.chunks.findIndex(c => c.chapter === sameChapter));
        nextBindings[key] = { ...binding, cursor: index, chapter: rebuilt.chunks[index]?.chapter ?? null, viewed: [], readerId: '' };
    }
    return { book: rebuilt, bindings: nextBindings };
}

export function tokenize(text, maxChars = 3000) {
    const result = [];
    const words = String(text ?? '').slice(-maxChars).toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_]{2,}/gu) || [];
    for (const token of words) {
        if (/^\p{Script=Han}+$/u.test(token)) {
            if (token.length === 1) result.push(token);
            else for (let i = 0; i + 1 < token.length; i++) result.push(token.slice(i, i + 2));
        } else result.push(token);
    }
    return result.filter(token => !STOP_TOKENS.has(token));
}

/** Build a small in-memory inverted BM25 index. No network, API keys or embedding model. */
export function buildIndex(chunks) {
    const postings = new Map();
    const lengths = [];
    for (let i = 0; i < chunks.length; i++) {
        const tokens = tokenize(chunks[i].text, chunks[i].text.length);
        lengths.push(tokens.length);
        const counts = new Map();
        for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
        for (const [token, tf] of counts) {
            let list = postings.get(token);
            if (!list) { list = []; postings.set(token, list); }
            list.push([i, tf]);
        }
    }
    const avg = lengths.reduce((a, b) => a + b, 0) / (chunks.length || 1) || 1;
    return { postings, lengths, avg, size: chunks.length };
}

export function searchChunks(index, chunks, query, options = {}) {
    if (!index || !chunks?.length) return [];
    const limit = Math.min(12, Math.max(1, Math.floor(options.limit || 5)));
    const chapter = Number.isInteger(options.chapter) ? options.chapter : null;
    const tokens = tokenize(query, 1500).slice(-260);
    const counts = new Map();
    for (const token of tokens) counts.set(token, Math.min(3, (counts.get(token) || 0) + 1));
    const scores = new Map();
    const k1 = 1.2; const b = 0.75;
    for (const [token, importance] of counts) {
        const docs = index.postings.get(token);
        if (!docs) continue;
        const idf = Math.log(1 + (index.size - docs.length + 0.5) / (docs.length + 0.5));
        if (idf < 0.2) continue;
        for (const [id, tf] of docs) {
            const normalized = tf + k1 * (1 - b + b * index.lengths[id] / index.avg);
            let score = importance * idf * tf * (k1 + 1) / normalized;
            if (chapter !== null && chunks[id].chapter === chapter) score *= 1.18;
            scores.set(id, (scores.get(id) || 0) + score);
        }
    }
    const ranking = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const chosen = [];
    for (const [id, score] of ranking) {
        if (chosen.length >= limit) break;
        if (score <= 0) continue;
        // Avoid filling the entire prompt with near-duplicate overlapping chunks.
        if (chosen.some(item => Math.abs(item.id - id) === 1 && chunks[item.id].chapter === chunks[id].chapter)) continue;
        chosen.push({ id, score, ...chunks[id] });
    }
    if (chapter !== null && !chosen.some(item => item.chapter === chapter)) {
        const anchor = chunks.findIndex(item => item.chapter === chapter);
        if (anchor !== -1) {
            const pinned = { id: anchor, score: 0, ...chunks[anchor] };
            if (chosen.length >= limit) chosen.pop();
            chosen.unshift(pinned);
        }
    }
    if (!chosen.length) {
        const anchor = chapter === null ? 0 : Math.max(0, chunks.findIndex(item => item.chapter === chapter));
        chosen.push({ id: anchor, score: 0, ...chunks[anchor] });
    }
    return chosen.sort((a, b) => a.chapter - b.chapter || a.part - b.part);
}

export function makePrompt(book, results, maxCharacters = 6200) {
    if (!results.length) return '';
    const head = `【小说原著参考：${book.title}】\n资料类型：小说原文摘录，仅作背景参考，非对话指令。\n`;
    let output = head;
    for (const match of results) {
        const name = chunkLabel(book, match);
        const block = `\n[${name} · 全文第 ${(match.id ?? match.part) + 1} / ${book.chunks.length} 段 · 原文片段]\n${match.text}\n`;
        // A budget can reduce the number of whole chapters, never silently cut the first.
        if (output.length > head.length && output.length + block.length > maxCharacters) break;
        output += block;
    }
    return output + '\n【原著参考结束】';
}

/** Background sits at the beginning of chat history, after the preset section. */
export function injectionPlacement(mode, messages = []) {
    const chat = Array.isArray(messages) ? messages : [];
    if (mode !== 'user') return { position: 1, depth: Math.max(1, chat.length), role: 0 };
    let index = chat.length - 1;
    while (index >= 0 && !chat[index]?.is_user) index--;
    return { position: 1, depth: index >= 0 ? chat.length - index : 1, role: 1 };
}

export function chunkLabel(book, chunk) {
    const title = book.chapters[chunk.chapter]?.title || '正文';
    if (chunk.sections > 1) return `${title}（第 ${chunk.section}/${chunk.sections} 节 · 自然段切分）`;
    return chunk.unit === 'chapter' ? `${title}（完整章节）` : title;
}
