#!/usr/bin/env node
/**
 * After n8n is healthy: deactivate+activate workflows that have telegramTrigger
 * so setWebhook runs in the LIVE process (same as manual UI publish).
 *
 * Requires N8N_API_KEY (Settings → API in n8n UI).
 * If unset — skip (pre-start clear also skips without the key).
 * Activate HTTP ≥400 → process.exit(1) so the failure is visible in logs.
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

/** /healthz can be up before Public API routes exist — wait for GET /api/v1/workflows. */
async function waitApiReady() {
	const deadline = Date.now() + WAIT_SEC * 1000;
	while (Date.now() < deadline) {
		try {
			const res = await request('GET', '/api/v1/workflows?limit=1');
			if (res.status >= 200 && res.status < 300) return true;
		} catch {
			/* retry */
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

async function postWithRetry(urlPath, label) {
	const attempts = 4;
	let last = { status: 0, body: '' };
	for (let i = 1; i <= attempts; i += 1) {
		last = await request('POST', urlPath);
		if (last.status < 400) return last;
		if (last.status !== 404 || i === attempts) return last;
		warn(`${label}: HTTP 404 (API not ready?), retry ${i}/${attempts}`);
		await new Promise((r) => setTimeout(r, 2000 * i));
	}
	return last;
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

	log(`waiting for ${BASE}/api/v1/workflows (up to ${WAIT_SEC}s)`);
	if (!(await waitApiReady())) {
		warn('n8n Public API not ready in time; skip');
		return;
	}

	if (!ids.length) {
		log('no active telegramTrigger workflows');
		return;
	}

	let activateFailed = false;
	for (const id of ids) {
		log(`re-register ${id}`);
		const off = await postWithRetry(`/api/v1/workflows/${id}/deactivate`, `deactivate ${id}`);
		if (off.status >= 400) {
			warn(`deactivate ${id}: HTTP ${off.status} ${briefBody(off.body)}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		const on = await postWithRetry(`/api/v1/workflows/${id}/activate`, `activate ${id}`);
		if (on.status >= 400) {
			warn(`activate ${id}: HTTP ${on.status} ${briefBody(on.body)}`);
			activateFailed = true;
		} else {
			log(`activated ${id}`);
		}
	}
	if (activateFailed) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[n8n-reregister-tg] ERROR: ${err.message}`);
	process.exit(1);
});
