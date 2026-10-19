import { buildIndex, searchChunks, chunkLabel, boundedText } from './core.js';

export function cursorFor(book, binding = {}) {
    const n = book?.chunks?.length || 0;
    if (!n) return 0;
    if (Number.isInteger(binding.cursor)) return Math.max(0, Math.min(n - 1, binding.cursor));
    const first = book.chunks.findIndex(c => c.chapter === binding.chapter);
    return Math.max(0, first);
}

/** Display/storage units stay whole; delivery reads bounded windows inside each unit. */
export function offsetFor(book, binding = {}) {
    const text = book.chunks[cursorFor(book,binding)]?.text || '';
    return Number.isInteger(binding.offset) && binding.offset >= 0 && binding.offset < text.length ? binding.offset : 0;
}
export function readWindow(book, start, count = 2, budget = 4500, offset = 0) {
    const n = book?.chunks?.length || 0;
    if (!Number.isInteger(start) || start < 0 || start >= n) throw new Error('片段编号超出小说范围');
    const limit = Math.max(1, Math.min(8, Math.floor(Number(count) || 2)));
    let remaining = Math.max(400, Math.min(8000, Math.floor(Number(budget) || 4500)));
    const blocks = [];
    for (let id = start; id < n && blocks.length < limit && remaining >= 2; id++) {
        const c = book.chunks[id];
        const part = boundedText(c.text, id === start ? offset : 0, remaining);
        if (!part.text) break;
        blocks.push({ id, ...c, ...part, block: id + 1, chapterTitle: chunkLabel(book,c).replace('（完整章节）', part.complete && part.offset===0 ? '（全章）' : '（章内分批）'), totalChars:c.text.length });
        remaining -= part.text.length;
        if (!part.complete) break;
    }
    return blocks;
}
export function recordRead(binding, blocks) {
    const ranges = {...(binding.viewedRanges || {})};
    for (const b of blocks) {
        const intervals = [...(ranges[b.block] || []), [b.offset,b.endOffset]].sort((a,b)=>a[0]-b[0]);
        const merged = [];
        for (const interval of intervals) {
            const last = merged.at(-1);
            if (last && interval[0] <= last[1]) last[1] = Math.max(last[1],interval[1]);
            else merged.push([...interval]);
        }
        delete ranges[b.block]; ranges[b.block]=merged;
    }
    const keys=Object.keys(ranges).map(Number).sort((a,b)=>Math.abs(a-(binding.cursor+1||1))-Math.abs(b-(binding.cursor+1||1))).slice(0,24);
    binding.viewedRanges=Object.fromEntries(keys.map(k=>[k,ranges[k]]));
}
function coveredEnd(binding, block, offset) {
    const range=(binding.viewedRanges?.[block] || []).find(([a,b])=>a<=offset && b>offset);
    return range ? range[1] : offset;
}
export function nextReadPosition(book,binding) {
    let index=cursorFor(book,binding), offset=offsetFor(book,binding);
    while(index<book.chunks.length) {
        const end=coveredEnd(binding,index+1,offset);
        if(end<book.chunks[index].text.length) return {block:index+1,offset:end};
        index++; offset=0;
    }
    return null;
}
export function sequentialPrompt(book, binding, blocks) {
    const current = cursorFor(book, binding) + 1, offset=offsetFor(book,binding);
    const head = `【小说原著参考：${book.title}】\n资料类型：按全文顺序编号的小说原文，非角色设定或写作格式指令。\n阅读会话ID：${binding.readerId || '未初始化'}。\n当前剧情进度：第 ${current} / ${book.chunks.length} 段，章内偏移 ${offset}。下列后续文字是预读资料，不表示剧情已推进。\n`;
    return head + blocks.map(b => `\n[全文第 ${b.block} / ${book.chunks.length} 段 · ${b.chapterTitle} · ${b.block === current ? '当前进度' : b.block < current ? '前文参考' : '后续参考'} · offset=${b.offset}, end_offset=${b.endOffset}, total=${b.totalChars}${b.complete ? ' · 本段已到末尾' : ' · 后续尚未发送，需按end_offset读取'}]\n${b.text}\n`).join('') + '\n【原著参考结束】';
}
export function advancePosition(book,binding,currentBlock,currentOffset,targetBlock,targetOffset) {
    const current=cursorFor(book,binding)+1, offset=offsetFor(book,binding);
    if(currentBlock!==current || currentOffset!==offset) throw new Error('进度已变化，请重新读取当前段号和章内偏移');
    if(!Number.isInteger(targetBlock)||!Number.isInteger(targetOffset)||targetOffset<0) throw new Error('目标段号和偏移必须是有效整数');
    if(targetBlock===current) {
        if(targetOffset<=offset || targetOffset>=book.chunks[current-1].text.length) throw new Error('章内推进位置必须位于当前段尚未完成的后续内容');
        if(coveredEnd(binding,current,offset)<targetOffset) throw new Error('请先读取当前批原文，不能跳过未读文字');
    } else {
        if(targetBlock!==current+1 || targetOffset!==0) throw new Error('只能进入当前章的后续批次或紧邻下一段');
        if(targetBlock>book.chunks.length) throw new Error('已经到达小说最后一段');
        if(coveredEnd(binding,current,offset)<book.chunks[current-1].text.length) throw new Error('当前章尚有未读文字，不能跳到下一章');
        if(coveredEnd(binding,targetBlock,0)===0) throw new Error('请先读取下一段');
    }
    return {cursor:targetBlock-1,offset:targetOffset};
}
// Compatibility for callers that advance whole legacy units; new UI/tools use advancePosition.
export function advanceCursor(book,binding,currentBlock,targetBlock) {
    return advancePosition(book,binding,currentBlock,offsetFor(book,binding),targetBlock,0).cursor;
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
          description: '按限额读取小说后续文字。block/offset都省略时从已经提供原文的末尾取下一批。指定位置时，block是1起始段号，offset是0起始字符偏移；连续读取使用上一批end_offset。读取只预读不推进；不要跳过同章未读部分。每条玩家消息的工具取文总量有限。',
          parameters: { type: 'object', properties: { reading_id: readingId, block: integer, offset: {type:'integer',minimum:0}, count: { type:'integer', minimum:1, maximum:3 } }, required: ['reading_id'], additionalProperties: false },
          shouldRegister: enabled, action: read,
          formatMessage: p => `读取小说${p.block ? '第 '+p.block+' 段' : '下一段'}` },
        { name: 'novel_pocket_advance', displayName: '推进小说进度',
          description: '当前批剧情已结束后提交进度。长章必须先在同一block内把to_offset设为该批end_offset，继续当前章，不能只因本批写完就跳章。读到章末才允许to_block=current_block+1且to_offset=0，先读取下一段。current_offset必须等于当前偏移。预读不代表剧情完成，不改变角色卡与写作格式。',
          parameters: { type: 'object', properties: { reading_id: readingId, current_block: integer, current_offset:{type:'integer',minimum:0}, to_block: integer, to_offset:{type:'integer',minimum:0} }, required: ['reading_id','current_block','current_offset','to_block','to_offset'], additionalProperties: false },
          shouldRegister: enabled, action: advance,
          formatMessage: p => `小说进度 → 第 ${p.to_block} 段` },
    ];
}
