#!/usr/bin/env node
/**
 * Exit 0 = CLI publish can be skipped (export unchanged + DB has published versions).
 * Exit 1 = publish required.
 *
 * Env:
 *   N8N_FORCE_PUBLISH_ON_START=true  — always exit 1
 *   N8N_PUBLISH_FINGERPRINT_FILE      — default /home/node/.n8n/.n8n-auto-import-publish-fingerprint
 *   N8N_DATABASE_SQLITE
 */
'use strict';

const fs = require('fs');
const Module = require('module');

const { computeWorkflowsFingerprint, activeWorkflowIds } = require('./n8n_export_utils');

const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';
const PUBLISH_FP_FILE =
	process.env.N8N_PUBLISH_FINGERPRINT_FILE || '/home/node/.n8n/.n8n-auto-import-publish-fingerprint';

function loadSqlite3() {
	try {
		return require('sqlite3');
	} catch {
		const req = Module.createRequire('/usr/local/lib/node_modules/n8n/package.json');
		return req('sqlite3');
	}
}

function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
	});
}

async function dbPublishedOk(ids) {
	if (!ids.length) return true;
	if (!fs.existsSync(DB_PATH)) return false;

	const sqlite3 = loadSqlite3();
	const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
	try {
		const placeholders = ids.map(() => '?').join(',');
		const rows = await all(
			db,
			`SELECT id, activeVersionId FROM workflow_entity WHERE id IN (${placeholders})`,
			ids,
		);
		const byId = new Map(rows.map((r) => [r.id, r]));
		for (const id of ids) {
			const row = byId.get(id);
			if (!row?.activeVersionId) {
				process.stderr.write(`[n8n-publish-needed] missing published version: ${id}\n`);
				return false;
			}
		}
		return true;
	} finally {
		db.close();
	}
}

async function main() {
	if (process.env.N8N_FORCE_PUBLISH_ON_START === 'true' || process.env.N8N_FORCE_PUBLISH_ON_START === '1') {
		process.stderr.write('[n8n-publish-needed] force publish\n');
		process.exit(1);
	}

	const fp = computeWorkflowsFingerprint();
	const ids = activeWorkflowIds();
	if (!ids.length) {
		process.exit(0);
	}

	let savedFp = '';
	if (fs.existsSync(PUBLISH_FP_FILE)) {
		savedFp = fs.readFileSync(PUBLISH_FP_FILE, 'utf8').trim();
	}

	if (!fp || fp !== savedFp) {
		process.stderr.write('[n8n-publish-needed] export fingerprint changed or no publish marker\n');
		process.exit(1);
	}

	if (!(await dbPublishedOk(ids))) {
		process.exit(1);
	}

	process.stderr.write('[n8n-publish-needed] skip ok\n');
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[n8n-publish-needed] ERROR: ${err.message}\n`);
	process.exit(1);
});
