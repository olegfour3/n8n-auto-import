#!/usr/bin/env node
/**
 * Remap workflow node credentials to existing credentials by (type, name).
 *
 * Why: n8n export often has inconsistent credential ids for the same name;
 * import:workflow keeps those ids, so nodes point at missing credentials even
 * when a stub/real credential with the same name already exists.
 *
 * Prefers credentials with non-empty secret fields; else oldest createdAt.
 *
 * Env:
 *   N8N_DATABASE_SQLITE (default /home/node/.n8n/database.sqlite)
 *   N8N_CONFIG_FILE     (default /home/node/.n8n/config)
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';
const CONFIG_PATH = process.env.N8N_CONFIG_FILE || '/home/node/.n8n/config';

function log(msg) {
	console.log(`[n8n-remap-creds] ${msg}`);
}

function warn(msg) {
	console.warn(`[n8n-remap-creds] WARN: ${msg}`);
}

function loadSqlite3() {
	try {
		return require('sqlite3');
	} catch {
		const req = Module.createRequire('/usr/local/lib/node_modules/n8n/package.json');
		return req('sqlite3');
	}
}

function decryptCredentialData(encrypted, encryptionKey) {
	const input = Buffer.from(encrypted, 'base64');
	if (input.length < 16) return null;
	const salt = input.subarray(8, 16);
	const password = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
	const hash1 = crypto.createHash('md5').update(password).digest();
	const hash2 = crypto.createHash('md5').update(Buffer.concat([hash1, password])).digest();
	const iv = crypto.createHash('md5').update(Buffer.concat([hash2, password])).digest();
	const derivedKey = Buffer.concat([hash1, hash2]);
	const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
	const plain = Buffer.concat([
		decipher.update(input.subarray(16)),
		decipher.final(),
	]).toString('utf8');
	return JSON.parse(plain);
}

function hasUsefulSecret(data) {
	if (!data || typeof data !== 'object') return false;
	const secretKeys = [
		'accessToken',
		'apiKey',
		'password',
		'clientSecret',
		'oauthTokenData',
	];
	for (const k of secretKeys) {
		const v = data[k];
		if (typeof v === 'string' && v.trim()) return true;
		if (v && typeof v === 'object') return true;
	}
	return false;
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

function buildPreferredMap(rows, encryptionKey) {
	/** @type {Map<string, {id:string, score:number, createdAt:string}>} */
	const best = new Map();
	for (const row of rows) {
		const key = `${row.type}\0${row.name}`;
		let score = 0;
		try {
			const data = decryptCredentialData(row.data, encryptionKey);
			if (hasUsefulSecret(data)) score = 2;
			else if (data && Object.keys(data).length) score = 1;
		} catch {
			score = 0;
		}
		const cur = best.get(key);
		if (
			!cur ||
			score > cur.score ||
			(score === cur.score && String(row.createdAt) < String(cur.createdAt))
		) {
			best.set(key, {
				id: row.id,
				score,
				createdAt: String(row.createdAt || ''),
			});
		}
	}
	/** @type {Map<string, string>} type\0name -> id */
	const out = new Map();
	for (const [key, v] of best) out.set(key, v.id);
	return out;
}

function remapNodes(nodes, preferredByKey, knownIds) {
	let changes = 0;
	if (!Array.isArray(nodes)) return { nodes, changes };
	for (const node of nodes) {
		const creds = node && node.credentials;
		if (!creds || typeof creds !== 'object') continue;
		for (const [ctype, meta] of Object.entries(creds)) {
			if (!meta || typeof meta !== 'object') continue;
			const name = meta.name;
			if (!name) continue;
			const preferred = preferredByKey.get(`${ctype}\0${name}`);
			if (!preferred) continue;
			const curId = meta.id;
			if (curId === preferred) continue;
			if (curId && knownIds.has(curId) && curId === preferred) continue;
			// Remap when missing id, unknown id, or different id for same name
			if (!curId || !knownIds.has(curId) || curId !== preferred) {
				meta.id = preferred;
				changes += 1;
			}
		}
	}
	return { nodes, changes };
}

async function main() {
	if (!fs.existsSync(DB_PATH)) {
		log('no database yet; skip');
		return 0;
	}
	if (!fs.existsSync(CONFIG_PATH)) {
		warn(`config not found: ${CONFIG_PATH}; skip`);
		return 0;
	}
	const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	if (!cfg.encryptionKey) {
		warn('encryptionKey missing; skip');
		return 0;
	}

	const sqlite3 = loadSqlite3();
	const db = new sqlite3.Database(DB_PATH);

	try {
		const credRows = await all(
			db,
			'SELECT id, name, type, data, createdAt FROM credentials_entity',
		);
		const preferredByKey = buildPreferredMap(credRows, cfg.encryptionKey);
		const knownIds = new Set(credRows.map((r) => r.id));
		log(`credentials=${credRows.length} groups=${preferredByKey.size}`);

		let total = 0;

		const entities = await all(db, 'SELECT id, name, nodes, activeVersionId FROM workflow_entity');
		for (const wf of entities) {
			let nodes;
			try {
				nodes = JSON.parse(wf.nodes);
			} catch {
				warn(`bad nodes JSON in workflow_entity ${wf.id}`);
				continue;
			}
			const { nodes: next, changes } = remapNodes(nodes, preferredByKey, knownIds);
			if (changes > 0) {
				await run(db, 'UPDATE workflow_entity SET nodes = ? WHERE id = ?', [
					JSON.stringify(next),
					wf.id,
				]);
				total += changes;
				log(`entity ${wf.name}: remapped ${changes}`);
			}

			if (wf.activeVersionId) {
				const hist = await all(
					db,
					'SELECT versionId, nodes FROM workflow_history WHERE versionId = ?',
					[wf.activeVersionId],
				);
				if (hist[0] && hist[0].nodes) {
					let hNodes;
					try {
						hNodes = JSON.parse(hist[0].nodes);
					} catch {
						continue;
					}
					const remapped = remapNodes(hNodes, preferredByKey, knownIds);
					if (remapped.changes > 0) {
						await run(db, 'UPDATE workflow_history SET nodes = ? WHERE versionId = ?', [
							JSON.stringify(remapped.nodes),
							wf.activeVersionId,
						]);
						total += remapped.changes;
						log(`history ${wf.name}@${wf.activeVersionId}: remapped ${remapped.changes}`);
					}
				}
			}
		}

		// Also fix any other history versions referenced as published
		const pubs = await all(
			db,
			'SELECT workflowId, publishedVersionId FROM workflow_published_version',
		).catch(() => []);
		for (const p of pubs) {
			if (!p.publishedVersionId) continue;
			const hist = await all(
				db,
				'SELECT versionId, nodes FROM workflow_history WHERE versionId = ?',
				[p.publishedVersionId],
			);
			if (!hist[0] || !hist[0].nodes) continue;
			let hNodes;
			try {
				hNodes = JSON.parse(hist[0].nodes);
			} catch {
				continue;
			}
			const remapped = remapNodes(hNodes, preferredByKey, knownIds);
			if (remapped.changes > 0) {
				await run(db, 'UPDATE workflow_history SET nodes = ? WHERE versionId = ?', [
					JSON.stringify(remapped.nodes),
					p.publishedVersionId,
				]);
				total += remapped.changes;
				log(`published ${p.workflowId}@${p.publishedVersionId}: remapped ${remapped.changes}`);
			}
		}

		log(`done, remapped ${total} credential binding(s)`);
		return 0;
	} finally {
		db.close();
	}
}

main()
	.then((code) => process.exit(code || 0))
	.catch((err) => {
		warn(err && err.stack ? err.stack : String(err));
		process.exit(1);
	});
