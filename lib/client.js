/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = GerritClient;

var mod_fsm = require('mooremachine');
var mod_sshagent = require('sshpk-agent');
var mod_sshpk = require('sshpk');
var mod_events = require('events');
var mod_fs = require('fs');
var mod_cproc = require('child_process');
var mod_util = require('util');
var mod_assert = require('assert-plus');
var mod_lstream = require('lstream');
var mod_vsjson = require('vstream-json-parser');
var mod_bunyan = require('bunyan');

var SSHAgentRunner = require('./ssh-agent-runner');
var SSHCmdRunner = require('./ssh-cmd-runner');
var EventStream = require('./event-stream');

function GerritClient(opts) {
	mod_assert.object(opts, 'options');

	mod_assert.optionalObject(opts.log, 'options.log');

	mod_assert.string(opts.user, 'options.user');
	mod_assert.string(opts.host, 'options.host');
	mod_assert.optionalNumber(opts.port, 'options.sshPort');

	mod_assert.optionalObject(opts.recovery, 'options.recovery');

	mod_assert.optionalString(opts.keyFile, 'options.keyFile');
	mod_assert.optionalObject(opts.key, 'options.key');
	if (opts.keyFile === undefined && opts.key === undefined) {
		throw (new Error('One of either options.keyFile or ' +
		    'options.key must be supplied'));
	}

	this.gc_user = opts.user;
	this.gc_port = opts.sshPort;
	this.gc_host = opts.host;

	var key = opts.key;
	if (key === undefined) {
		var data = mod_fs.readFileSync(opts.keyFile);
		key = mod_sshpk.parsePrivateKey(data);
	}

	this.gc_recovery = opts.recovery;
	if (this.gc_recovery === undefined) {
		this.gc_recovery = {
			default: {
				timeout: 2000,
				maxTimeout: 10000,
				retries: 5,
				delay: 250,
				maxDelay: 2000
			}
		};
	}

	this.gc_log = opts.log;
	if (opts.log === undefined) {
		this.gc_log = mod_bunyan.createLogger(
		    { name: 'gerrit-client' });
	}

	this.gc_ar = new SSHAgentRunner({
		log: this.gc_log
	});
	var self = this;
	this.gc_ar.on('stateChanged', function (st) {
		if (st === 'running') {
			var agent = (self.gc_agent = self.gc_ar.makeClient());
			agent.addKey(key, function (err) {
				if (err) {
					self.emit('error', err);
					return;
				}

				self.version(function (err2) {
					if (err2) {
						self.emit('error', err2);
						return;
					}
					self.emit('connect');
				});
			});
		}
	});

	mod_events.EventEmitter.call(this);
}
mod_util.inherits(GerritClient, mod_events.EventEmitter);

GerritClient.prototype._makeRunner = function (opts) {
	opts.agentRunner = this.gc_ar;
	opts.user = this.gc_user;
	opts.host = this.gc_host;
	opts.port = this.gc_port;
	opts.log = this.gc_log;
	opts.recovery = this.gc_recovery;
	return (new SSHCmdRunner(opts));
};

GerritClient.prototype.eventStream = function () {
	return (new EventStream({
		user: this.gc_user,
		host: this.gc_host,
		port: this.gc_port,
		agentRunner: this.gc_ar,
		log: this.gc_log,
		recovery: this.gc_recovery
	}));
};

GerritClient.prototype.version = function (cb) {
	mod_assert.func(cb, 'callback');
	var runner = this._makeRunner({
		args: ['version']
	});
	var output = '';
	runner.stdout.on('readable', function () {
		var data;
		while ((data = runner.stdout.read()) !== null) {
			output += data.toString('utf-8');
		}
	});
	runner.on('finished', function (status) {
		if (status === 0) {
			cb(null, output.trim());
		} else {
			cb(new Error('Command exited with status ' + status));
		}
	});
	runner.on('error', cb);
};

GerritClient.prototype.queryStream = function (query, fields) {
	mod_assert.string(query, 'query');
	mod_assert.optionalArrayOfString(fields, 'fields');
	if (fields === undefined)
		fields = [];

	var args = ['query', '--format', 'json'];
	fields = fields.map(function (f) { return ('--' + f); });
	args = args.concat(fields);
	args.push('--');
	args = args.concat(query.split(/\s+/));

	var runner = this._makeRunner({ args: args });
	var vsjson = new mod_vsjson();
	runner.stdout.pipe(vsjson);
	runner.on('finished', function (status) {
		if (status !== 0) {
			vsjson.emit('error',
			    new Error('Exited with status ' + status));
		}
	});
	runner.on('error', function (err) {
		vsjson.emit('error', err);
	});
	return (vsjson);
};

/*JSSTYLED*/
var SHA_OR_PS = /([a-fA-F0-9]+)|([0-9]+,[0-9]+)/;

GerritClient.prototype.review = function (shaOrPatchset, opts, cb) {
	mod_assert.string(shaOrPatchset, 'sha or change,patchset');
	mod_assert.ok(SHA_OR_PS.test(shaOrPatchset), 'sha or change,patchset');
	mod_assert.object(opts, 'options');
	mod_assert.optionalString(opts.project, 'options.project');

	var project = opts.project;
	var payload = {};

	mod_assert.string(opts.message, 'options.message');
	payload.message = opts.message;
	mod_assert.optionalObject(opts.labels, 'options.labels');
	Object.keys(opts.labels).forEach(function (lbl) {
		mod_assert.string(opts.labels[lbl], 'value for label ' + lbl);
	});
	payload.labels = opts.labels;
	mod_assert.optionalObject(opts.comments, 'options.comments');
	if (opts.comments !== undefined) {
		Object.keys(opts.comments).forEach(function (fn) {
			var cs = opts.comments[fn];
			mod_assert.arrayOfObject(cs, 'comments[' + fn + ']');
			cs.forEach(function (c) {
				mod_assert.string(c.path,
				    'comments[' + fn + '].path');
				mod_assert.number(c.line,
				    'comments[' + fn + '].line');
				mod_assert.string(c.message,
				    'comments[' + fn + '].message');
			});
		});
	}
	payload.comments = opts.comments;
	mod_assert.optionalString(opts.notify, 'options.notify');
	payload.notify = opts.notify;
	mod_assert.optionalString(opts.tag, 'options.tag');
	payload.tag = opts.tag;

	var args = ['review', shaOrPatchset, '--json'];
	if (project !== undefined) {
		args.push('--project');
		args.push(project);
	}

	var runner = this._makeRunner({ args: args });
	var output = '';
	runner.on('stateChanged', function (st) {
		if (st === 'running') {
			runner.stdin.write(JSON.stringify(payload));
		}
	})
	runner.stdout.on('readable', function () {
		var data;
		while ((data = runner.stdout.read()) !== null) {
			output += data.toString('utf-8');
		}
	});
	runner.on('finished', function (status) {
		if (status === 0) {
			cb(null, output.trim());
		} else {
			cb(new Error('Command exited with status ' + status));
		}
	});
	runner.on('error', cb);
};
