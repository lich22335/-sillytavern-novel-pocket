import { buildIndex, searchChunks, chunkLabel } from './core.js';

export function cursorFor(book, binding = {}) {
    const n = book?.chunks?.length || 0;
    if (!n) return 0;
    if (Number.isInteger(binding.cursor)) return Math.max(0, Math.min(n - 1, binding.cursor));
    const first = book.chunks.findIndex(c => c.chapter === binding.chapter);
    return Math.max(0, first);
}

/** Whole numbered blocks only, no silently skipped or clipped text. */
export function readWindow(book, start, count = 2, budget = 6200) {
    const n = book?.chunks?.length || 0;
    if (!Number.isInteger(start) || start < 0 || start >= n) throw new Error('片段编号超出小说范围');
    const limit = Math.max(1, Math.min(8, Math.floor(Number(count) || 2)));
    const max = Math.max(400, Math.min(8000, Math.floor(Number(budget) || 6200)));
    const blocks = [];
    let used = 0;
    for (let id = start; id < n && blocks.length < limit; id++) {
        const c = book.chunks[id];
        const block = { id, ...c, block: id + 1, chapterTitle: chunkLabel(book, c) };
        // Always supply the first complete block, even if an old book has a large block.
        if (blocks.length && used + c.text.length + 100 > max) break;
        blocks.push(block); used += c.text.length + 100;
    }
    return blocks;
}

export function sequentialPrompt(book, binding, blocks) {
    const current = cursorFor(book, binding) + 1;
    const head = `【小说原著参考：${book.title}】\n资料类型：按全文顺序编号的小说原文，非角色设定或写作格式指令。\n阅读会话ID：${binding.readerId || "未初始化"}。\n当前剧情进度：第 ${current} / ${book.chunks.length} 段。下列后续段落为预读资料，预读不代表剧情已推进。\n`;
    return head + blocks.map(b => `\n[全文第 ${b.block} / ${book.chunks.length} 段 · ${b.chapterTitle} · ${b.block === current ? '当前进度' : b.block < current ? '前文参考' : '后续参考'}]\n${b.text}\n`).join('') + '\n【原著参考结束】';
}

export function advanceCursor(book, binding, currentBlock, targetBlock) {
    const current = cursorFor(book, binding) + 1;
    if (currentBlock !== current) throw new Error(`进度已变化，当前是第 ${current} 段，请重新读取进度`);
    if (targetBlock !== current + 1) throw new Error('自动推进一次只能进入下一段；任意跳转请在管理窗口操作');
    if (targetBlock > book.chunks.length) throw new Error('已经到达小说最后一段');
    if (!Array.isArray(binding.viewed) || !binding.viewed.includes(targetBlock)) throw new Error('请先读取下一段，再推进进度');
    return targetBlock - 1;
}

export function locatePassage(book, passage) {
    const clean = s => String(s || '').replace(/\s+/g, '');
    const q = clean(passage);
    if (q.length < 6) throw new Error('请粘贴至少六个字，最好是一两句原文');
    const hits = [];
    for (let id = 0; id < book.chunks.length; id++) {
        // Last 80 chars anchor the END of the pasted scene, rather than its beginning.
        if (clean(book.chunks[id].text).includes(q.slice(-80))) hits.push({ id, exact: true });
    }
    if (hits.length) return hits.slice(0, 5);
    return searchChunks(buildIndex(book.chunks), book.chunks, passage, { limit: 5 })
        .filter(hit => hit.score > 0).sort((a,b) => b.score - a.score).map(hit => ({ id: hit.id, exact: false }));
}

export function novelTools({ enabled, read, advance }) {
    const integer = { type: 'integer', minimum: 1 };
    const readingId = { type: 'string', description: '必须原样传小说参考中的阅读会话ID，防止换聊天后误操作' };
    return [
        { name: 'novel_pocket_read', displayName: '读取小说片段',
          description: '读取本聊天绑定小说的编号片段。block省略时读取当前剧情进度的下一段。根据小说参考中的当前段号，在需要后续原文时调用。读取仅是预读，不改变剧情进度，不更改角色卡或输出格式。',
          parameters: { type: 'object', properties: { reading_id: readingId, block: integer, count: { type:'integer', minimum:1, maximum:3 } }, required: ['reading_id'], additionalProperties: false },
          shouldRegister: enabled, action: read,
          formatMessage: p => `读取小说${p.block ? '第 '+p.block+' 段' : '下一段'}` },
        { name: 'novel_pocket_advance', displayName: '推进小说进度',
          description: '当前段的剧情确实结束后调用，把进度推进一段。必须先读取下一段。current_block传当前段号，to_block传下一段号。只是预读或打算写后续时不要调用；玩家改变剧情时不强迫原著事件发生。',
          parameters: { type: 'object', properties: { reading_id: readingId, current_block: integer, to_block: integer }, required: ['reading_id','current_block','to_block'], additionalProperties: false },
          shouldRegister: enabled, action: advance,
          formatMessage: p => `小说进度 → 第 ${p.to_block} 段` },
    ];
}
