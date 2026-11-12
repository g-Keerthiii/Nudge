import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RULES } from './rules.js';

const FILE = process.env.DB_FILE || path.join(process.cwd(), 'data', 'db.json');
let db = { rules: { ...DEFAULT_RULES }, invoices: {}, escalations: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

let timer = null;
export const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch (e) { console.warn('db save failed', e.message); }
  }, 150);
};
export const store = () => db;
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
