#!/usr/bin/env node
/**
 * Snapshot / restore workflow_entity.parentFolderId around n8n import:workflow.
 *
 * Usage:
 *   node n8n_preserve_folders.js snapshot [snapshot.json]
 *   node n8n_preserve_folders.js restore  [snapshot.json]
 *
 * Env:
 *   N8N_DATABASE_SQLITE  (default /home/node/.n8n/database.sqlite)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';
const SNAPSHOT =
	process.argv[3] || process.env.N8N_FOLDER_SNAPSHOT || '/tmp/n8n-folder-snapshot.json';
const MODE = process.argv[2];

function log(msg) {
	console.log(`[n8n-folders] ${msg}`);
}

function warn(msg) {
	console.warn(`[n8n-folders] WARN: ${msg}`);
}

function loadSqlite3() {
	try {
		return require('sqlite3');
	} catch {
		const req = Module.createRequire('/usr/local/lib/node_modules/n8n/package.json');
		return req('sqlite3');
	}
}

function openDb(mode) {
	const sqlite3 = loadSqlite3();
	const flag = mode === 'ro' ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE;
	return new sqlite3.Database(DB_PATH, flag);
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

function close(db) {
	return new Promise((resolve, reject) => {
		db.close((err) => (err ? reject(err) : resolve()));
	});
}

async function snapshot() {
	if (!fs.existsSync(DB_PATH)) {
		log('no database yet; empty snapshot');
		fs.writeFileSync(SNAPSHOT, '{}');
		return;
	}
	const db = openDb('ro');
	try {
		const rows = await all(
			db,
			`SELECT id, parentFolderId FROM workflow_entity WHERE parentFolderId IS NOT NULL`,
		);
		const map = {};
		for (const r of rows) {
			map[r.id] = r.parentFolderId;
		}
		fs.writeFileSync(SNAPSHOT, JSON.stringify(map));
		log(`snapshot ${Object.keys(map).length} folder assignment(s) -> ${SNAPSHOT}`);
	} finally {
		await close(db);
	}
}

async function restore() {
	if (!fs.existsSync(SNAPSHOT)) {
		log('no snapshot file; skip restore');
		return;
	}
	const map = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
	const ids = Object.keys(map);
	if (ids.length === 0) {
		log('snapshot empty; nothing to restore');
		return;
	}
	if (!fs.existsSync(DB_PATH)) {
		warn('database missing; skip restore');
		return;
	}
	const db = openDb('rw');
	try {
		let restored = 0;
		let skipped = 0;
		await run(db, 'BEGIN');
		for (const id of ids) {
			const folderId = map[id];
			// Only restore if workflow still exists and folder still exists
			const wf = await all(db, `SELECT id FROM workflow_entity WHERE id = ?`, [id]);
			if (!wf.length) {
				skipped++;
				continue;
			}
			const folder = await all(db, `SELECT id FROM folder WHERE id = ?`, [folderId]);
			if (!folder.length) {
				warn(`folder ${folderId} gone for workflow ${id}; skip`);
				skipped++;
				continue;
			}
			await run(db, `UPDATE workflow_entity SET parentFolderId = ? WHERE id = ?`, [
				folderId,
				id,
			]);
			restored++;
		}
		await run(db, 'COMMIT');
		log(`restored=${restored} skipped=${skipped}`);
	} catch (e) {
		try {
			await run(db, 'ROLLBACK');
		} catch {
			/* ignore */
		}
		throw e;
	} finally {
		await close(db);
		try {
			fs.unlinkSync(SNAPSHOT);
		} catch {
			/* ignore */
		}
	}
}

async function main() {
	if (MODE === 'snapshot') {
		await snapshot();
		return 0;
	}
	if (MODE === 'restore') {
		await restore();
		return 0;
	}
	console.error('Usage: n8n_preserve_folders.js snapshot|restore [snapshot.json]');
	return 2;
}

main()
	.then((code) => process.exit(code || 0))
	.catch((e) => {
		warn(e.message || String(e));
		process.exit(1);
	});
