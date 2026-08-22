#!/usr/bin/env node
/**
 * Deactivate workflows in n8n SQLite that are not present in n8n_export/*.json.
 * Source of truth is git export; stale UI-only / old-id copies must not stay active
 * (duplicate webhook paths, ghost Telegram triggers).
 *
 * Usage: node n8n_deactivate_orphans.js
 * Env:   N8N_WORKFLOWS_IMPORT_DIR, N8N_DATABASE_SQLITE
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const WORKFLOWS_DIR = process.env.N8N_WORKFLOWS_IMPORT_DIR || '/workflows';
const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';

function log(msg) {
	console.log(`[n8n-deactivate-orphans] ${msg}`);
}

function loadSqlite3() {
	try {
		return require('sqlite3');
	} catch {
		const req = Module.createRequire('/usr/local/lib/node_modules/n8n/package.json');
		return req('sqlite3');
	}
}

function exportIds() {
	const ids = new Set();
	if (!fs.existsSync(WORKFLOWS_DIR)) return ids;
	for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'))) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
			if (data?.id) ids.add(data.id);
		} catch {
			/* ignore */
		}
	}
	return ids;
}

function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
	});
}

function run(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function onRun(err) {
			if (err) reject(err);
			else resolve(this);
		});
	});
}

async function main() {
	if (!fs.existsSync(DB_PATH)) {
		log('no database yet; skip');
		return;
	}

	const allowed = exportIds();
	if (!allowed.size) {
		log('no export ids; skip');
		return;
	}

	const sqlite3 = loadSqlite3();
	const db = new sqlite3.Database(DB_PATH);
	try {
		const rows = await all(
			db,
			'SELECT id, name FROM workflow_entity WHERE active = 1',
		);
		const orphans = rows.filter((row) => !allowed.has(row.id));
		if (!orphans.length) {
			log('no active orphan workflows');
			return;
		}

		await run(db, 'BEGIN');
		for (const row of orphans) {
			await run(db, 'UPDATE workflow_entity SET active = 0 WHERE id = ?', [row.id]);
			log(`deactivated orphan ${row.id} (${row.name || 'unnamed'})`);
		}
		await run(db, 'COMMIT');
	} catch (err) {
		await run(db, 'ROLLBACK').catch(() => {});
		throw err;
	} finally {
		db.close();
	}
}

main().catch((err) => {
	console.error(`[n8n-deactivate-orphans] ERROR: ${err.message}`);
	process.exit(1);
});
