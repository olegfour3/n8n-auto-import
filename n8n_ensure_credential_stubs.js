#!/usr/bin/env node
/**
 * Create missing n8n credentials as empty stubs matched by (type, name)
 * from workflow JSON files. Never overwrites existing credentials.
 *
 * Env:
 *   N8N_WORKFLOWS_IMPORT_DIR  (default /workflows)
 *   N8N_CONFIG_PATH           (default /home/node/.n8n/config)
 *   N8N_CRED_STUBS_DIR        (default /tmp/n8n-cred-stubs)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKFLOWS_DIR = process.env.N8N_WORKFLOWS_IMPORT_DIR || '/workflows';
const CONFIG_PATH = process.env.N8N_CONFIG_PATH || '/home/node/.n8n/config';
const STUBS_DIR = process.env.N8N_CRED_STUBS_DIR || '/tmp/n8n-cred-stubs';

/** Minimal empty payloads per credential type used in n8n_export. */
const EMPTY_DATA_BY_TYPE = {
	telegramApi: { accessToken: '' },
	smtp: {
		user: '',
		password: '',
		host: '',
		port: 465,
		secure: true,
		disableStartTls: false,
	},
	googlePalmApi: { apiKey: '' },
	anthropicApi: { apiKey: '' },
	googleOAuth2Api: {
		clientId: '',
		clientSecret: '',
	},
	googleDriveOAuth2Api: {
		clientId: '',
		clientSecret: '',
	},
	googleSheetsOAuth2Api: {
		clientId: '',
		clientSecret: '',
	},
};

function log(msg) {
	console.log(`[n8n-cred-stubs] ${msg}`);
}

function warn(msg) {
	console.warn(`[n8n-cred-stubs] WARN: ${msg}`);
}

function genId() {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let s = '';
	for (let i = 0; i < 16; i++) {
		s += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return s;
}

function collectNeededCredentials(workflowsDir) {
	const needed = new Map(); // key: type\0name -> {type, name}
	if (!fs.existsSync(workflowsDir)) {
		return needed;
	}
	for (const file of fs.readdirSync(workflowsDir)) {
		if (!file.endsWith('.json')) continue;
		let wf;
		try {
			wf = JSON.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));
		} catch (e) {
			warn(`skip ${file}: ${e.message}`);
			continue;
		}
		for (const node of wf.nodes || []) {
			const creds = node.credentials || {};
			for (const [ctype, meta] of Object.entries(creds)) {
				if (!meta || typeof meta !== 'object') continue;
				const name = meta.name;
				if (!name) continue;
				needed.set(`${ctype}\0${name}`, { type: ctype, name });
			}
		}
	}
	return needed;
}

function listExistingCredentials() {
	const tmp = fs.mkdtempSync('/tmp/n8n-cred-export-');
	try {
		execFileSync(
			'n8n',
			['export:credentials', '--all', '--separate', `--output=${tmp}`],
			{ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
		);
	} catch (e) {
		const stderr = (e.stderr || e.message || '').toString();
		// Fresh install may have zero credentials — still ok if dir empty
		if (!fs.existsSync(tmp) || fs.readdirSync(tmp).length === 0) {
			if (/Successfully exported 0|no credentials/i.test(stderr + (e.stdout || ''))) {
				return new Set();
			}
			warn(`export:credentials failed: ${stderr.slice(0, 300)}`);
			return new Set();
		}
	}
	const existing = new Set();
	for (const file of fs.readdirSync(tmp)) {
		if (!file.endsWith('.json')) continue;
		try {
			const c = JSON.parse(fs.readFileSync(path.join(tmp, file), 'utf8'));
			if (c.type && c.name) existing.add(`${c.type}\0${c.name}`);
		} catch {
			/* skip */
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	return existing;
}

function encryptData(plainObj, encryptionKey) {
	// Prefer n8n-core CBC (same as instance). Fall back paths for NODE_PATH layouts.
	let CipherAes256CBC;
	try {
		({ CipherAes256CBC } = require('n8n-core'));
	} catch {
		const Module = require('module');
		const n8nRoot = '/usr/local/lib/node_modules/n8n';
		const paths = Module._nodeModulePaths(n8nRoot);
		const req = Module.createRequire(path.join(n8nRoot, 'package.json'));
		({ CipherAes256CBC } = req('n8n-core'));
		void paths;
	}
	const cbc = new CipherAes256CBC();
	return cbc.encrypt(JSON.stringify(plainObj), encryptionKey);
}

function main() {
	const needed = collectNeededCredentials(WORKFLOWS_DIR);
	if (needed.size === 0) {
		log('no credentials referenced in workflows');
		return 0;
	}

	const existing = listExistingCredentials();
	log(`needed=${needed.size} existing=${existing.size}`);

	const missing = [];
	for (const [key, ref] of needed) {
		if (!existing.has(key)) missing.push(ref);
	}
	if (missing.length === 0) {
		log('all credential stubs already present');
		return 0;
	}

	if (!fs.existsSync(CONFIG_PATH)) {
		warn(`config not found: ${CONFIG_PATH}; skip stubs`);
		return 0;
	}
	const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	if (!cfg.encryptionKey) {
		warn('encryptionKey missing in config; skip stubs');
		return 0;
	}

	fs.rmSync(STUBS_DIR, { recursive: true, force: true });
	fs.mkdirSync(STUBS_DIR, { recursive: true });

	const files = [];
	for (const { type, name } of missing) {
		const plain = EMPTY_DATA_BY_TYPE[type] || {};
		if (!EMPTY_DATA_BY_TYPE[type]) {
			warn(`no empty template for type=${type}; using {}`);
		}
		const id = genId();
		const stub = {
			id,
			name,
			type,
			data: encryptData(plain, cfg.encryptionKey),
		};
		const out = path.join(STUBS_DIR, `${id}.json`);
		fs.writeFileSync(out, JSON.stringify(stub, null, 2));
		files.push(out);
		log(`stub ${type} / ${name} -> ${id}`);
	}

	try {
		execFileSync('n8n', ['import:credentials', '--separate', `--input=${STUBS_DIR}`], {
			stdio: 'inherit',
		});
		log(`imported ${files.length} stub(s)`);
	} catch (e) {
		warn(`import:credentials failed: ${e.message}`);
		return 1;
	} finally {
		fs.rmSync(STUBS_DIR, { recursive: true, force: true });
	}
	return 0;
}

process.exit(main());
