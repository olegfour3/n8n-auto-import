#!/usr/bin/env node
/**
 * Force-clear Telegram webhooks for bots used by active telegramTrigger workflows.
 *
 * Why: after nightly n8n stop/start, Telegram Trigger often stays "activated" in logs
 * but updates never arrive — typically because checkExists() sees the old URL and
 * skips setWebhook, while Telegram / n8n secret or listener state is stale.
 * Deleting the webhook before main process start makes activate() always call create().
 *
 * Env:
 *   N8N_DATABASE_SQLITE     (default /home/node/.n8n/database.sqlite)
 *   N8N_CONFIG_FILE         (default /home/node/.n8n/config)
 *   N8N_WORKFLOWS_IMPORT_DIR (default /workflows) — only clear bots from active=true exports
 *   N8N_CLEAR_TELEGRAM_WEBHOOKS=false — kill-switch
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const Module = require('module');

const DB_PATH = process.env.N8N_DATABASE_SQLITE || '/home/node/.n8n/database.sqlite';
const CONFIG_PATH = process.env.N8N_CONFIG_FILE || '/home/node/.n8n/config';
const WORKFLOWS_DIR = process.env.N8N_WORKFLOWS_IMPORT_DIR || '/workflows';
const ENABLED = process.env.N8N_CLEAR_TELEGRAM_WEBHOOKS !== 'false'
	&& process.env.N8N_CLEAR_TELEGRAM_WEBHOOKS !== '0';

function log(msg) {
	console.log(`[n8n-clear-tg-webhooks] ${msg}`);
}

function warn(msg) {
	console.error(`[n8n-clear-tg-webhooks] WARN: ${msg}`);
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

function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
	});
}

function telegramCredentialRefsFromExport() {
	/** @type {{ ids: Set<string>, names: Set<string> }} */
	const refs = { ids: new Set(), names: new Set() };
	if (!fs.existsSync(WORKFLOWS_DIR)) return refs;
	for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'))) {
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
		} catch {
			continue;
		}
		if (!data || data.active !== true) continue;
		for (const node of data.nodes || []) {
			if (node.type !== 'n8n-nodes-base.telegramTrigger') continue;
			const cred = node.credentials?.telegramApi;
			if (!cred) continue;
			// n8n remaps credential ids on import — prefer name match
			if (typeof cred.name === 'string' && cred.name.trim()) refs.names.add(cred.name.trim());
			if (typeof cred.id === 'string' && cred.id.trim()) refs.ids.add(cred.id.trim());
		}
	}
	return refs;
}

function deleteWebhook(token) {
	return new Promise((resolve) => {
		const url = `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`;
		const req = https.get(url, { timeout: 15000 }, (res) => {
			let body = '';
			res.on('data', (chunk) => {
				body += chunk;
			});
			res.on('end', () => {
				try {
					const parsed = JSON.parse(body);
					resolve({ ok: !!parsed.ok, description: parsed.description || '' });
				} catch {
					resolve({ ok: false, description: `bad response HTTP ${res.statusCode}` });
				}
			});
		});
		req.on('error', (err) => resolve({ ok: false, description: err.message }));
		req.on('timeout', () => {
			req.destroy();
			resolve({ ok: false, description: 'timeout' });
		});
	});
}

async function main() {
	if (!ENABLED) {
		log('disabled (N8N_CLEAR_TELEGRAM_WEBHOOKS=false)');
		return;
	}
	if (!fs.existsSync(DB_PATH) || !fs.existsSync(CONFIG_PATH)) {
		log('no db/config yet; skip');
		return;
	}

	const refs = telegramCredentialRefsFromExport();
	if (!refs.ids.size && !refs.names.size) {
		log('no telegramTrigger credentials in active exports; skip');
		return;
	}

	const encryptionKey = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).encryptionKey;
	if (!encryptionKey) {
		warn('no encryptionKey in config; skip');
		return;
	}

	const sqlite3 = loadSqlite3();
	const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
	try {
		const clauses = [];
		const params = [];
		if (refs.ids.size) {
			clauses.push(`id IN (${[...refs.ids].map(() => '?').join(',')})`);
			params.push(...refs.ids);
		}
		if (refs.names.size) {
			clauses.push(`name IN (${[...refs.names].map(() => '?').join(',')})`);
			params.push(...refs.names);
		}
		const rows = await all(
			db,
			`SELECT id, name, data FROM credentials_entity WHERE type = 'telegramApi' AND (${clauses.join(' OR ')})`,
			params,
		);
		if (!rows.length) {
			warn(
				`no matching telegramApi credentials (ids=${[...refs.ids].join(',') || '-'} names=${[...refs.names].join(',') || '-'})`,
			);
			return;
		}

		const tokens = new Set();
		for (const row of rows) {
			try {
				const data = decryptCredentialData(row.data, encryptionKey);
				const token = data?.accessToken || data?.access_token;
				if (typeof token === 'string' && token.trim()) {
					tokens.add(token.trim());
					log(`credential ${row.id} (${row.name}): token ok`);
				} else {
					warn(`credential ${row.id} (${row.name}): no accessToken`);
				}
			} catch (err) {
				warn(`credential ${row.id} decrypt failed: ${err.message}`);
			}
		}

		if (!tokens.size) {
			warn('no bot tokens decrypted; skip');
			return;
		}

		for (const token of tokens) {
			const result = await deleteWebhook(token);
			if (result.ok) {
				log('deleteWebhook ok');
			} else {
				warn(`deleteWebhook failed: ${result.description}`);
			}
		}
	} finally {
		db.close();
	}
}

main().catch((err) => {
	console.error(`[n8n-clear-tg-webhooks] ERROR: ${err.message}`);
	process.exit(1);
});
