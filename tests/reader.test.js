import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorFor, readWindow, sequentialPrompt, advanceCursor, locatePassage, novelTools, advancePosition, offsetFor, recordRead, nextReadPosition } from '../reader.js';

const book = { title: '测试小说', chapters: [{title:'第一章'}, {title:'第二章'}], chunks: [
    {chapter:0,part:0,text:'苏青进入古堡，管家递上钥匙。'},
    {chapter:0,part:1,text:'苏青打开北门，看见骑士留下的信。'},
    {chapter:1,part:2,text:'沈月乘船来到南岛，码头正在下雨。'},
    {chapter:1,part:3,text:'沈月走进旅馆，老板说昨日有人失踪。'},
] };

test('跨章节编号连续，旧聊天选定章节迁移到章节首段', () => {
    assert.equal(cursorFor(book, {chapter:1}), 2);
    assert.deepEqual(readWindow(book, 1, 3).map(b => b.block), [2,3,4]);
    assert.equal(cursorFor(book, {cursor:999}), 3);
});
test('发送窗口累计不超过预算，部分章节保留后续偏移', () => {
    const long = {...book, chunks:book.chunks.map(c=>({...c,text:c.text.repeat(35)}))};
    const window = readWindow(long, 0, 3, 500);
    const sent=window.map(b=>b.text).join('');
    assert.ok(sent.length<=500);
    assert.equal(sent,long.chunks.map(c=>c.text).join('').slice(0,sent.length));
    assert.ok(window.every(b=>b.endOffset>b.offset));
    assert.throws(()=>readWindow(book, -1));
    assert.throws(()=>readWindow(book, 4));
});
test('预读不推进，明确区分当前段和后续参考', () => {
    const binding = {cursor:1,readerId:'reading-test'};
    const blocks = readWindow(book, 1, 2);
    const prompt = sequentialPrompt(book,binding,blocks);
    assert.equal(binding.cursor, 1);
    assert.match(prompt,/第 2 \/ 4 段/);
    assert.match(prompt,/第 3 \/ 4 段.*后续参考/);
    assert.match(prompt,/reading-test/);
});
test('推进必须读过下一段，拒绝跳段、重复调用、越过书尾', () => {
    const b = {cursor:0,viewed:[]};
    recordRead(b,readWindow(book,0,1));
    assert.throws(()=>advanceCursor(book,b,1,2),/先读取/);
    recordRead(b,readWindow(book,1,1)); b.cursor = advanceCursor(book,b,1,2);
    assert.equal(b.cursor,1);
    assert.throws(()=>advanceCursor(book,b,1,2),/进度已变化/);
    assert.throws(()=>advanceCursor(book,b,2,4),/只能/);
    assert.throws(()=>advanceCursor(book,{cursor:3,viewed:[5]},4,5),/最后/);
});
test('同一本书在不同聊天中保存独立进度', () => {
    const a = {cursor:0,viewed:[2]}, b = {cursor:0};
    recordRead(a,readWindow(book,0,2));
    a.cursor = advanceCursor(book,a,1,2);
    assert.equal(cursorFor(book,a),1);
    assert.equal(cursorFor(book,b),0);
});
test('粘贴原文以场景结尾定位，短文本拒绝，近似匹配需标注', () => {
    assert.deepEqual(locatePassage(book,'沈月乘船来到南岛，码头正在下雨。')[0],{id:2,exact:true});
    assert.throws(()=>locatePassage(book,'沈月'),/六个字/);
    const hits=locatePassage(book,'苏青想知道北门骑士的信');
    assert.equal(hits[0].id,1); assert.equal(hits[0].exact,false);
});
test('原生工具按当前聊天动态启用，会话标识是必填参数', async () => {
    let on=true;
    const tools=novelTools({enabled:()=>on,read:async()=>({progress_changed:false}),advance:async()=>({progress_changed:true})});
    assert.equal(tools.length,2);
    assert.equal(await tools[0].shouldRegister(),true); on=false;
    assert.equal(await tools[0].shouldRegister(),false);
    assert.ok(tools.every(t=>t.parameters.required.includes('reading_id')));
    assert.equal((await tools[0].action({reading_id:'r'})).progress_changed,false);
});

test('同章按批读取与推进，没读完本章不能跳章', () => {
    const long={...book,chunks:[{chapter:0,part:0,text:'甲'.repeat(10000)},{chapter:1,part:1,text:'下一章。'}]};
    const b={cursor:0,offset:0};
    const first=readWindow(long,0,1,3000,offsetFor(long,b)); recordRead(b,first);
    assert.equal(first[0].endOffset,3000); assert.equal(first[0].complete,false);
    assert.deepEqual(nextReadPosition(long,b),{block:1,offset:3000});
    recordRead(b,readWindow(long,1,1));
    assert.throws(()=>advancePosition(long,b,1,0,2,0),/尚有未读/);
    const next=advancePosition(long,b,1,0,1,3000); Object.assign(b,next);
    assert.equal(b.cursor,0); assert.equal(b.offset,3000);
    assert.throws(()=>advancePosition(long,b,1,0,1,3000),/进度已变化/);
    let joined=first[0].text;
    while(b.offset<9000) {
        const page=readWindow(long,0,1,3000,b.offset); recordRead(b,page); joined+=page[0].text;
        Object.assign(b,advancePosition(long,b,1,b.offset,1,page[0].endOffset));
    }
    const last=readWindow(long,0,1,3000,b.offset); recordRead(b,last); joined+=last[0].text;
    assert.equal(joined,long.chunks[0].text);
    Object.assign(b,advancePosition(long,b,1,b.offset,2,0));
    assert.equal(b.cursor,1); assert.equal(b.offset,0);
});
test('不相邻预读不能算成完整阅读，防止章内跳过空缺', () => {
    const b={cursor:0,offset:0};
    const long={...book,chunks:[{chapter:0,text:'甲'.repeat(3000)}]};
    recordRead(b,readWindow(long,0,1,400,0)); recordRead(b,readWindow(long,0,1,400,1000));
    assert.throws(()=>advancePosition(long,b,1,0,1,1200),/跳过未读/);
    assert.deepEqual(nextReadPosition(long,b),{block:1,offset:400});
});
