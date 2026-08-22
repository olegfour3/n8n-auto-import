#!/usr/bin/env node
/**
 * Topological publish order for active workflows in N8N_WORKFLOWS_IMPORT_DIR.
 * Sub-workflows (Execute Workflow targets) are listed before callers.
 *
 * Output: one workflow id per line, dependencies first.
 * Exit 1 if a cycle is detected among active workflows.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.env.N8N_WORKFLOWS_IMPORT_DIR || process.argv[2] || '/workflows';

function loadWorkflows() {
	const workflows = new Map();
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

function dependencyIds(workflow, knownIds) {
	const deps = new Set();
	for (const node of workflow.nodes || []) {
		if (node.type !== 'n8n-nodes-base.executeWorkflow') continue;
		const target = node.parameters?.workflowId?.value;
		if (typeof target === 'string' && target && knownIds.has(target)) {
			deps.add(target);
		}
	}
	return deps;
}

function topoLevelsActive(workflows) {
	const knownIds = new Set(workflows.keys());
	const activeIds = [...workflows.entries()]
		.filter(([, wf]) => wf.active === true)
		.map(([id]) => id);

	const depsById = new Map();
	for (const id of activeIds) {
		depsById.set(id, dependencyIds(workflows.get(id), knownIds));
	}

	const inDegree = new Map(activeIds.map((id) => [id, depsById.get(id).size]));
	let queue = activeIds.filter((id) => inDegree.get(id) === 0).sort();
	const levels = [];

	while (queue.length) {
		levels.push([...queue]);
		const nextQueue = [];
		for (const id of queue) {
			for (const other of activeIds) {
				if (!depsById.get(other).has(id)) continue;
				const next = inDegree.get(other) - 1;
				inDegree.set(other, next);
				if (next === 0) nextQueue.push(other);
			}
		}
		queue = nextQueue.sort();
	}

	const flat = levels.flat();
	if (flat.length !== activeIds.length) {
		const stuck = activeIds.filter((id) => !flat.includes(id)).sort();
		process.stderr.write(
			`[n8n-publish-order] cycle among active workflows: ${stuck.join(', ')}\n`,
		);
		process.exit(1);
	}

	return levels;
}

function main() {
	if (!fs.existsSync(dir)) return;
	const workflows = loadWorkflows();
	const levels = topoLevelsActive(workflows);
	for (let i = 0; i < levels.length; i += 1) {
		if (i > 0) process.stdout.write('\n');
		for (const id of levels[i]) {
			process.stdout.write(`${id}\n`);
		}
	}
}

main();
