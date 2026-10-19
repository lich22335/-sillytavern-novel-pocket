import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChapters, chunkBook, buildIndex, searchChunks, makePrompt, injectionPlacement, rebuildBook } from '../core.js';

const novel = [
    '第一章 雾中的城堡',
    '苏青和沈月来到雾岭城堡，城堡外的钟楼每天午夜都会敲十三下。'.repeat(18),
    '第二章 被隐藏的信',
    '沈月在图书馆找到一封祖母留下的密信，信封上写着不要相信管家。'.repeat(18),
    '第三章 夜色里的约定',
    '苏青在湖边见到黑衣骑士，他们约定明天晚上打开古堡的北门。'.repeat(18),
].join('\n');

test('章节识别和文本完整拆分', () => {
    const chapters = parseChapters(novel);
    assert.equal(chapters.length, 3);
    assert.equal(chapters[1].title, '第二章 被隐藏的信');
    const book = chunkBook(novel);
    assert.equal(book.chapters.length, 3);
    assert.ok(book.chunks.length >= 3);
    assert.ok(book.chunks.every(c => c.text.length > 0));
    assert.ok(book.chunks.some(c => c.chapter === 2 && c.text.includes('黑衣骑士')));
});

test('中文关键词匹配正确章节，不调用模型', () => {
    const book = chunkBook(novel);
    const index = buildIndex(book.chunks);
    const results = searchChunks(index, book.chunks, '沈月在图书馆找到的祖母密信写了什么？', { limit: 3 });
    assert.ok(results.length);
    assert.ok(results.some(r => r.chapter === 1));
    assert.ok(results.some(r => r.text.includes("不要相信管家")));
});

test('指定章节对简单「继续」查询提供章节锚点', () => {
    const book = chunkBook(novel);
    const matches = searchChunks(buildIndex(book.chunks), book.chunks, '继续', { chapter: 2, limit: 4 });
    assert.ok(matches.some(m => m.chapter === 2));
});

test('提示词字数预算生效且不写入整本小说', () => {
    const book = { title: '雾岭之夜', ...chunkBook(novel) };
    const hits = searchChunks(buildIndex(book.chunks), book.chunks, '城堡图书馆密信管家', { limit: 5 });
    const prompt = makePrompt(book, hits, 1200);
    assert.ok(prompt.length < 1300);
    assert.match(prompt, /原著参考/);
    assert.match(prompt, /原文片段/);
    assert.ok(prompt.length < novel.length);
});

test('无章节的短文本作为完整正文，不按字数硬切', () => {
    const book = chunkBook('文字内容很丰富。'.repeat(140));
    assert.equal(book.chapters.length, 1);
    assert.equal(book.chunks.length, 1);
});

test('背景资料在聊天历史开头，随聊天长度定位', () => {
    assert.deepEqual(injectionPlacement(undefined), { position: 1, depth: 1, role: 0 });
    assert.deepEqual(injectionPlacement('background'), { position: 1, depth: 1, role: 0 });
    assert.deepEqual(injectionPlacement('background', [{}, {}, {}]), { position: 1, depth: 3, role: 0 });
    assert.equal(injectionPlacement('background', [{}, {}, {}, {}]).depth, 4);
});
test('用户参考定位在最近玩家发言之前，不更改消息', () => {
    const chat = [{ is_user: true, mes: '去城堡' }, { is_user: false, mes: '到达城堡' }];
    const original = JSON.stringify(chat);
    assert.deepEqual(injectionPlacement('user', chat), { position: 1, depth: 2, role: 1 });
    assert.equal(JSON.stringify(chat), original);
    assert.equal(injectionPlacement('user', [{ is_user: true }]).depth, 1);
});
test('原文参考不再附加写作和剧情控制要求', () => {
    const book = { title: '测试', chapters: [{title:'第一章'}], chunks: [{chapter:0,part:0,text:'城堡坐落在山顶。'}] };
    const p = makePrompt(book, [{chapter:0,text:'城堡坐落在山顶。'}]);
    assert.match(p, /非对话指令/);
    assert.doesNotMatch(p, /以当前聊天为准|不要向玩家提及|参考人物、背景与事件/);
});

test('常见数千字章节一章一段，不重叠，保留自然段', () => {
    const body = ['甲'.repeat(2100), '乙'.repeat(1900), '丙'.repeat(1700)].join('\n\n');
    const source = `第一章 完整事件\n${body}\n第二章 后续\n后续内容。`;
    const book = chunkBook(source);
    assert.equal(book.chunks.length, 2);
    assert.equal(book.chunks[0].text,body);
    assert.equal(book.chunks[0].unit,'chapter');
    assert.equal(book.sourceText,source);
    assert.equal(book.chunkVersion,2);
});
test('超长章节只在自然段边界分组，不截句也不重叠', () => {
    const paragraphs = ['甲'.repeat(4200),'乙'.repeat(4500),'丙'.repeat(4300),'丁'.repeat(3000)];
    const book=chunkBook('第一章 长章\n'+paragraphs.join('\n\n'));
    assert.ok(book.chunks.length > 1);
    assert.equal(book.chunks.map(c=>c.text).join('').replace(/\s/g,''),paragraphs.join(''));
    for (const para of paragraphs) assert.equal(book.chunks.filter(c=>c.text.includes(para)).length,1);
    assert.ok(book.chunks.every(c=>c.sections===book.chunks.length));
});
test('单个超长自然段完整保留，不为了限长强行截断', () => {
    const paragraph='不换行的完整段落。'.repeat(2000);
    const book=chunkBook('第一章\n'+paragraph);
    assert.equal(book.chunks.length,1);
    assert.equal(book.chunks[0].text,paragraph);
});
test('Markdown、大小写英文和带空格中文章标题', () => {
    assert.equal(parseChapters('## 第 1 章 开始\n内容甲\n## 第 2 章 后续\n内容乙').length,2);
    assert.equal(parseChapters('Chapter 1 Start\nText A\ncHaPtEr 2 Next\nText B').length,2);
    assert.equal(parseChapters('【第一章 起点】\n正文甲\n【第二章 后续】\n正文乙').length,2);
});
test('关键词索引覆盖完整长章开头，不只扫描末尾三千字', () => {
    const source='第一章\n翡翠鹦鹉藏在金色钟楼。'+'普通文字。'.repeat(1000)+'\n第二章\n海边码头\n第三章\n雨夜山路';
    const book=chunkBook(source);
    const result=searchChunks(buildIndex(book.chunks),book.chunks,'翡翠鹦鹉',{limit:1});
    assert.equal(result[0].chapter,0); assert.ok(result[0].score > 0);
});
test('预算只能减少整章数量，不能在提示词阶段又截断剧情', () => {
    const text='甲'.repeat(7000)+'结尾关键事件。';
    const book={title:'测试',...chunkBook('第一章\n'+text+'\n第二章\n另一件事。')};
    const result=makePrompt(book,book.chunks.map((c,id)=>({id,...c})),1000);
    assert.ok(result.includes(text)); assert.ok(!result.includes('另一件事。'));
});
test('旧书重切必须提供原文，保留书ID并映射所有聊天进度', () => {
    const old={id:'old',title:'旧书',chapters:[{title:'第一章'},{title:'第二章'}],chunks:[
        {chapter:0,text:'开始走进古堡。'}, {chapter:0,text:'苏青在北门发现骑士。'}, {chapter:1,text:'第二场景在码头。'}
    ]};
    const bindings={A:{bookId:'old',cursor:1,viewed:[2],readerId:'old-reader'},B:{bookId:'old',cursor:2},Other:{bookId:'other',cursor:9}};
    assert.throws(()=>rebuildBook(old,bindings),/原始 TXT/);
    const source='第一章\n开始走进古堡。\n苏青在北门发现骑士。\n第二章\n第二场景在码头。';
    const result=rebuildBook(old,bindings,source);
    assert.equal(result.book.id,old.id); assert.equal(result.book.sourceText,source);
    assert.equal(result.bindings.A.cursor,0); assert.equal(result.bindings.B.cursor,1);
    assert.equal(result.bindings.A.readerId,''); assert.deepEqual(result.bindings.A.viewed,[]);
    assert.equal(result.bindings.Other,bindings.Other);
    assert.equal(bindings.A.cursor,1); assert.equal(old.chunks.length,3);
});
