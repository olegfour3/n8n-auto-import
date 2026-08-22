#!/usr/bin/env node
/**
 * Fix non-parseable createdAt/updatedAt in n8n SQLite.
 * UI WorkflowsView crashes on null/invalid dates: e.createdAt.toString().
 *
 * Usage: node n8n_sanitize_timestamps.js
 * Env:   N8N_DATABASE_SQLITE (default /home/node/.n8n/database.sqlite)
 */
'use strict';

const Module = require('module');

const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';
const TABLES = ['workflow_entity', 'credentials_entity', 'shared_workflow', 'shared_credentials', 'folder'];

function log(msg) {
	console.log(`[n8n-sanitize-ts] ${msg}`);
}

function loadSqlite3() {
	try {
		return require('sqlite3');
	} catch {
		const req = Module.createRequire('/usr/local/lib/node_modules/n8n/package.json');
		return req('sqlite3');
	}
}

function isBadDate(v) {
	if (v == null || String(v).trim() === '') return true;
	return Number.isNaN(new Date(String(v)).getTime());
}

function sqlNow() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
	});
}

function run(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) {
			if (err) reject(err);
			else resolve(this);
		});
	});
}

async function main() {
	const fs = require('fs');
	if (!fs.existsSync(DB_PATH)) {
		log('no database yet; skip');
		return;
	}
	const sqlite3 = loadSqlite3();
	const db = new sqlite3.Database(DB_PATH);
	let fixed = 0;
	try {
		await run(db, 'BEGIN');
		for (const table of TABLES) {
			const cols = await all(db, `PRAGMA table_info(${table})`);
			if (!cols.length) continue;
			const names = new Set(cols.map((c) => c.name));
			if (!names.has('createdAt')) continue;
			const rows = await all(db, `SELECT rowid AS rid, createdAt, updatedAt FROM ${table}`);
			for (const r of rows) {
				let ca = r.createdAt;
				let ua = r.updatedAt;
				let changed = false;
				if (isBadDate(ca)) {
					ca = names.has('updatedAt') && !isBadDate(ua) ? ua : sqlNow();
					changed = true;
				}
				if (names.has('updatedAt') && isBadDate(ua)) {
					ua = ca;
					changed = true;
				}
				if (!changed) continue;
				if (names.has('updatedAt')) {
					await run(db, `UPDATE ${table} SET createdAt=?, updatedAt=? WHERE rowid=?`, [
						ca,
						ua,
						r.rid,
					]);
				} else {
					await run(db, `UPDATE ${table} SET createdAt=? WHERE rowid=?`, [ca, r.rid]);
				}
				fixed++;
			}
		}
		await run(db, 'COMMIT');
		log(`fixed ${fixed} row(s)`);
	} catch (e) {
		try {
			await run(db, 'ROLLBACK');
		} catch {
			/* ignore */
		}
		throw e;
	} finally {
		await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
	}
}

main().catch((e) => {
	console.error('[n8n-sanitize-ts]', e);
	process.exit(1);
});
