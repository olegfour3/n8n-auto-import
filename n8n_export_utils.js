#!/usr/bin/env node
/**
 * Shared helpers for n8n_export auto-import scripts.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function workflowsDir() {
	return process.env.N8N_WORKFLOWS_IMPORT_DIR || '/workflows';
}

function computeWorkflowsFingerprint(dir = workflowsDir()) {
	if (!fs.existsSync(dir)) return '';
	const h = crypto.createHash('sha256');
	for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
		h.update(f);
		h.update('\0');
		h.update(fs.readFileSync(path.join(dir, f)));
		h.update('\0');
	}
	return h.digest('hex');
}

function loadWorkflowsMap(dir = workflowsDir()) {
	const workflows = new Map();
	if (!fs.existsSync(dir)) return workflows;
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			if (data?.id) workflows.set(data.id, data);
		} catch {
			/* ignore bad json */
		}
	}
	return workflows;
}

function activeWorkflowIds(dir = workflowsDir()) {
	return [...loadWorkflowsMap(dir).entries()]
		.filter(([, wf]) => wf.active === true)
		.map(([id]) => id);
}

module.exports = {
	workflowsDir,
	computeWorkflowsFingerprint,
	loadWorkflowsMap,
	activeWorkflowIds,
};
