#!/usr/bin/env node
/**
 * Publish all active workflows in one n8n DB session (one CLI boot equivalent).
 * Reads ids from N8N_PUBLISH_ORDER_FILE (blank lines = dependency levels, ignored).
 *
 * Exit 0 on success, 1 on failure (entrypoint may fall back to per-id n8n CLI).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const N8N_ROOT = process.env.N8N_PACKAGE_ROOT || '/usr/local/lib/node_modules/n8n';
const ORDER_FILE = process.env.N8N_PUBLISH_ORDER_FILE || '/tmp/n8n-publish-order.txt';

function log(msg) {
	console.log(`[n8n-publish-batch] ${msg}`);
}

function warn(msg) {
	console.error(`[n8n-publish-batch] WARN: ${msg}`);
}

/** Blank lines separate dependency levels (same as CLI publish pass). */
function readPublishLevels() {
	if (!fs.existsSync(ORDER_FILE)) return [];
	const levels = [];
	let current = [];
	for (const line of fs.readFileSync(ORDER_FILE, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) {
			if (current.length) {
				levels.push(current);
				current = [];
			}
			continue;
		}
		current.push(t);
	}
	if (current.length) levels.push(current);
	return levels;
}

async function publishBatch() {
	if (!fs.existsSync(path.join(N8N_ROOT, 'package.json'))) {
		throw new Error(`n8n package not found at ${N8N_ROOT}`);
	}

	const req = Module.createRequire(path.join(N8N_ROOT, 'package.json'));
	process.env.NODE_CONFIG_DIR =
		process.env.NODE_CONFIG_DIR || path.join(N8N_ROOT, 'bin', 'config');

	req('reflect-metadata');
	req(path.join(N8N_ROOT, 'dist/config'));

	const { Container } = req('@n8n/di');
	const { DbConnection, WorkflowRepository } = req('@n8n/db');

	const db = Container.get(DbConnection);
	await db.init();
	await db.migrate();

	const repo = Container.get(WorkflowRepository);
	const levels = readPublishLevels();
	if (!levels.length) {
		log('no workflow ids to publish');
		await db.close();
		return;
	}

	for (let i = 0; i < levels.length; i += 1) {
		for (const id of levels[i]) {
			await repo.publishVersion(id);
			log(`published ${id} (level ${i + 1})`);
		}
	}

	await db.close();
}

publishBatch()
	.then(() => {
		process.exit(0);
	})
	.catch((err) => {
		warn(err.stack || err.message);
		process.exit(1);
	});
