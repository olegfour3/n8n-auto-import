#!/usr/bin/env node
/**
 * After n8n is healthy: deactivate+activate workflows that have telegramTrigger
 * so setWebhook runs in the LIVE process (same as manual UI publish).
 *
 * Requires N8N_API_KEY (Settings → API in n8n UI).
 * If unset — skip (pre-start clear also skips without the key).
 * Success is getWebhookInfo.url, not HTTP 200 from n8n.
 * Activate HTTP ≥400 or an empty webhook → process.exit(1).
 *
 * Env:
 *   N8N_API_KEY
 *   N8N_INTERNAL_URL (default http://127.0.0.1:5678)
 *   N8N_WORKFLOWS_IMPORT_DIR
 *   N8N_REREGISTER_TELEGRAM=false — kill-switch
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = (process.env.N8N_INTERNAL_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const API_KEY = process.env.N8N_API_KEY || '';
const WORKFLOWS_DIR = process.env.N8N_WORKFLOWS_IMPORT_DIR || '/workflows';
const ENABLED = process.env.N8N_REREGISTER_TELEGRAM !== 'false'
	&& process.env.N8N_REREGISTER_TELEGRAM !== '0';
const WAIT_SEC = Number(process.env.N8N_REREGISTER_WAIT_SEC || 90);

function log(msg) {
	console.log(`[n8n-reregister-tg] ${msg}`);
}

function warn(msg) {
	console.error(`[n8n-reregister-tg] WARN: ${msg}`);
}

function request(method, urlPath, body) {
	return new Promise((resolve, reject) => {
		const u = new URL(urlPath, `${BASE}/`);
		const lib = u.protocol === 'https:' ? https : http;
		const payload = body ? JSON.stringify(body) : null;
		const req = lib.request(
			{
				protocol: u.protocol,
				hostname: u.hostname,
				port: u.port || (u.protocol === 'https:' ? 443 : 80),
				path: u.pathname + u.search,
				method,
				headers: {
					Accept: 'application/json',
					'X-N8N-API-KEY': API_KEY,
					...(payload
						? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
						: {}),
				},
				timeout: 30000,
			},
			(res) => {
				let data = '';
				res.on('data', (c) => {
					data += c;
				});
				res.on('end', () => {
					resolve({ status: res.statusCode || 0, body: data });
				});
			},
		);
		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('timeout'));
		});
		if (payload) req.write(payload);
		req.end();
	});
}

function briefBody(body) {
	return String(body || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Editor SPA returns 200 HTML for unknown GET paths before Public API routes exist.
 * Only a JSON workflow list means POST /activate can work.
 */
function isWorkflowList(res) {
	if (!res || res.status < 200 || res.status >= 300) return false;
	const body = String(res.body || '').trim();
	if (!body.startsWith('{') && !body.startsWith('[')) return false;
	try {
		const parsed = JSON.parse(body);
		if (Array.isArray(parsed)) return true;
		return Array.isArray(parsed?.data);
	} catch {
		return false;
	}
}

/** Express default 404 while the route is not mounted yet. A real n8n 404 is JSON. */
function isRouteMissing(res) {
	if (!res || res.status !== 404) return false;
	const body = String(res.body || '');
	return /Cannot POST/i.test(body) || body.trim().startsWith('<');
}

/** /healthz and the editor HTML can be up before Public API routes exist. */
async function waitApiReady(deadline) {
	while (Date.now() < deadline) {
		try {
			const res = await request('GET', '/api/v1/workflows?limit=1');
			if (isWorkflowList(res)) return true;
		} catch {
			/* retry */
		}
		await sleep(2000);
	}
	return false;
}

async function postUntilReady(urlPath, label, deadline) {
	let attempt = 0;
	let last = { status: 0, body: '' };
	while (Date.now() < deadline) {
		attempt += 1;
		try {
			last = await request('POST', urlPath);
		} catch (err) {
			warn(`${label}: ${err.message}, retry ${attempt}`);
			await sleep(3000);
			continue;
		}
		if (last.status < 400) return last;
		const retryable = isRouteMissing(last) || last.status >= 500;
		if (!retryable) return last;
		warn(`${label}: HTTP ${last.status} (API not ready?), retry ${attempt}`);
		await sleep(3000);
	}
	return last;
}

function getWebhookInfo(token) {
	return new Promise((resolve) => {
		const req = https.get(
			`https://api.telegram.org/bot${token}/getWebhookInfo`,
			{ timeout: 15000 },
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk;
				});
				res.on('end', () => {
					try {
						const parsed = JSON.parse(body);
						const url = parsed?.result?.url || '';
						resolve({
							ok: !!parsed.ok && !!url,
							url,
							description: parsed.description || '',
						});
					} catch {
						resolve({ ok: false, url: '', description: `bad response HTTP ${res.statusCode}` });
					}
				});
			},
		);
		req.on('error', (err) => resolve({ ok: false, url: '', description: err.message }));
		req.on('timeout', () => {
			req.destroy();
			resolve({ ok: false, url: '', description: 'timeout' });
		});
	});
}

/** Ground truth: Telegram has a non-empty webhook URL for every bot token in active triggers. */
async function webhooksBound() {
	const { loadTelegramTokens } = require('./n8n_clear_telegram_webhooks');
	const tokens = await loadTelegramTokens();
	if (!tokens.length) {
		warn('webhook verify: no bot tokens');
		return false;
	}
	for (let i = 0; i < 5; i += 1) {
		const urls = [];
		let pending = false;
		for (const token of tokens) {
			const info = await getWebhookInfo(token);
			if (!info.url) {
				pending = true;
				if (info.description) warn(`getWebhookInfo: ${info.description}`);
				break;
			}
			urls.push(info.url);
		}
		if (!pending) {
			for (const url of urls) log(`webhook set: ${url}`);
			return true;
		}
		await sleep(2000);
	}
	warn('webhook url still empty after activate');
	return false;
}

function telegramWorkflowIds() {
	const ids = [];
	if (!fs.existsSync(WORKFLOWS_DIR)) return ids;
	for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'))) {
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
		} catch {
			continue;
		}
		if (!data?.id || data.active !== true) continue;
		const hasTg = (data.nodes || []).some((n) => n.type === 'n8n-nodes-base.telegramTrigger');
		if (hasTg) ids.push(data.id);
	}
	return ids;
}

async function main() {
	if (!ENABLED) {
		log('disabled');
		return;
	}

	const ids = telegramWorkflowIds();
	if (!API_KEY) {
		if (ids.length) {
			warn(
				`N8N_API_KEY not set; skip live re-register for ${ids.length} telegramTrigger workflow(s) (pre-start clear also skipped without key)`,
			);
		} else {
			log('N8N_API_KEY not set; skip live re-register');
		}
		return;
	}

	const deadline = Date.now() + WAIT_SEC * 1000;
	log(`waiting for ${BASE}/api/v1/workflows JSON (up to ${WAIT_SEC}s)`);
	if (!(await waitApiReady(deadline))) {
		warn('n8n Public API not ready in time');
		process.exit(1);
	}

	if (!ids.length) {
		log('no active telegramTrigger workflows');
		return;
	}

	let activateFailed = false;
	for (const id of ids) {
		log(`re-register ${id}`);
		const off = await postUntilReady(
			`/api/v1/workflows/${id}/deactivate`,
			`deactivate ${id}`,
			deadline,
		);
		if (off.status >= 400) {
			warn(`deactivate ${id}: HTTP ${off.status} ${briefBody(off.body)}`);
			if (isRouteMissing(off) || off.status >= 500 || off.status === 0) {
				activateFailed = true;
				break;
			}
		}
		await sleep(1000);
		const on = await postUntilReady(
			`/api/v1/workflows/${id}/activate`,
			`activate ${id}`,
			deadline,
		);
		if (on.status >= 400) {
			warn(`activate ${id}: HTTP ${on.status} ${briefBody(on.body)}`);
			activateFailed = true;
		} else {
			log(`activated ${id}`);
		}
	}
	if (activateFailed || !(await webhooksBound())) {
		process.exit(1);
	}
}

function selfCheck() {
	const assert = require('assert');
	assert.strictEqual(isWorkflowList({ status: 200, body: '{"data":[]}' }), true);
	assert.strictEqual(isWorkflowList({ status: 200, body: '<!DOCTYPE html><html>' }), false);
	assert.strictEqual(isWorkflowList({ status: 401, body: '{"message":"unauthorized"}' }), false);
	assert.strictEqual(
		isRouteMissing({ status: 404, body: 'Cannot POST /api/v1/workflows/x/activate' }),
		true,
	);
	assert.strictEqual(isRouteMissing({ status: 404, body: '{"message":"not found"}' }), false);
}

if (process.env.N8N_REREGISTER_SELF_CHECK === '1') {
	selfCheck();
	console.log('ok');
	process.exit(0);
}

if (require.main === module) {
	main().catch((err) => {
		console.error(`[n8n-reregister-tg] ERROR: ${err.message}`);
		process.exit(1);
	});
}

module.exports = { isWorkflowList, isRouteMissing };
