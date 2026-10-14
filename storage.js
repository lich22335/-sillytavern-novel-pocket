const DB_NAME = 'sillytavern-novel-pocket-v1';
const STORE = 'books';
let openPromise;

function db() {
    if (!openPromise) {
        openPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
        }).catch(error => { openPromise = null; throw error; });
    }
    return openPromise;
}

async function transact(method, arg) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, method === 'get' || method === 'getAll' ? 'readonly' : 'readwrite');
        const store = tx.objectStore(STORE);
        const request = method === 'getAll' ? store.getAll() : store[method](arg);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
    });
}
export const saveBook = value => transact('put', value);
export const loadBook = id => transact('get', id);
export const deleteBook = id => transact('delete', id);
export async function listBooks() {
    const books = await transact('getAll');
    return books.map(({ id, title, charCount, chapters, chunks }) => ({ id, title, charCount, chapters: chapters.length, chunks: chunks.length }));
}
