/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = GerritEventStream;

var mod_fsm = require('mooremachine');
var mod_cproc = require('child_process');
var mod_fs = require('fs');
var mod_util = require('util');
var mod_assert = require('assert-plus');
var mod_events = require('events');
var mod_stream = require('stream');
var mod_crypto = require('crypto');
var mod_verror = require('verror');
var mod_lstream = require('lstream');
var mod_vsjson = require('vstream-json-parser');
var mod_bunyan = require('bunyan');

function GerritEventStream(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.string(opts.user, 'options.user');
	mod_assert.string(opts.host, 'options.host');
	mod_assert.object(opts.agentRunner, 'options.agentRunner');
	mod_assert.optionalNumber(opts.port, 'options.port');
	mod_assert.object(opts.log, 'options.log');
	mod_assert.object(opts.recovery, 'options.recovery');

	var recovery = opts.recovery.gerrit_stream;
	if (recovery === undefined)
		recovery = opts.recovery.default;
	this.gw_retry = {
		max: recovery.retries,
		count: recovery.retries,
		timeout: recovery.timeout,
		maxTimeout: recovery.maxTimeout || Infinity,
		delay: recovery.delay,
		maxDelay: recovery.maxDelay || Infinity
	};

	this.gw_agentRunner = opts.agentRunner;
	this.gw_user = opts.user;
	if (opts.port === undefined)
		opts.port = 22;
	this.gw_port = opts.port;
	this.gw_host = opts.host;
	this.gw_tokill = [];
	this.gw_log = opts.log.child({ component: 'event-stream' });

	this.gw_kid = undefined;
	this.gw_errls = new mod_lstream();
	this.gw_outls = new mod_lstream();
	this.gw_vsjson = new mod_vsjson();
	this.gw_outls.pipe(this.gw_vsjson);

	var self = this;
	this.gw_outls.on('line', function (line) {
		self.gw_log.trace({ json: line }, 'got event');
	});

	mod_fsm.FSM.call(this, 'waitagent');
}
mod_util.inherits(GerritEventStream, mod_fsm.FSM);

Object.defineProperty(GerritEventStream.prototype, 'stream', {
	get: function () {
		return (this.gw_vsjson);
	}
});

GerritEventStream.prototype.state_waitagent = function (S) {
	if (this.gw_agentRunner.isInState('running')) {
		S.gotoState('spawning');
	} else {
		S.on(this.gw_agentRunner, 'stateChanged', function (st) {
			if (st === 'running')
				S.gotoState('spawning');
		});
	}
};

var BAD_AUTH = /^Permission denied/;
/*JSSTYLED*/
var NEED_CAP = /^Capability ([^ ]+) is required/;
var CMD_START = /^debug1: Sending command: gerrit/;
/*JSSTYLED*/
var EXIT_STATUS = /^debug1: Exit status ([0-9-]+)/;

GerritEventStream.prototype.state_spawning = function (S) {
	var self = this;

	var opts = {};
	opts.env = {};
	opts.env.SSH_AUTH_SOCK = this.gw_agentRunner.getSocket();
	opts.env.PATH = process.env.PATH;

	this.gw_kid = mod_cproc.spawn('ssh',
	    ['-v', '-p', this.gw_port,
	    '-o', 'ServerAliveInterval=10',
	    '-o', 'ServerAliveCountMax=1',
	    this.gw_user + '@' + this.gw_host,
	    'gerrit', 'stream-events'], opts);
	this.gw_log.info('spawned ssh for gerrit stream-events in pid %d',
	    this.gw_kid.pid);

	S.on(this.gw_kid, 'error', function (err) {
		self.gw_lastError = err;
		S.gotoState('error');
	});

	this.gw_kid.stderr.pipe(this.gw_errls, { end: false });
	this.gw_kid.stdout.pipe(this.gw_outls, { end: false });

	S.on(this.gw_errls, 'readable', function () {
		var line;
		while ((line = self.gw_errls.read()) !== null) {
			var m;
			if (line.match(BAD_AUTH)) {
				self.gw_lastError = new Error(
				    'Failed to authenticate to gerrit SSH');
				S.gotoState('error');
				return;
			} else if ((m = line.match(CMD_START))) {
				S.gotoState('running');
				return;
			}
		}
	});

	S.on(this.gw_kid, 'close', function (code) {
		self.gw_lastError = new Error('Exited with status ' + code);
		S.gotoState('error');
	});

	S.timeout(this.gw_retry.timeout, function () {
		self.gw_lastError = new Error('Timed out waiting for stream ' +
		    'to start');
		S.gotoState('error');
	});
};

GerritEventStream.prototype.state_running = function (S) {
	var self = this;
	this.emit('bootstrap');
	S.on(this.gw_errls, 'readable', function () {
		var line;
		while ((line = self.gw_errls.read()) !== null) {
			var m;
			if ((m = line.match(NEED_CAP))) {
				self.gw_lastError = new mod_verror.VError(
				    'Gerrit refused access: the user "%s" ' +
				    'does not have capability "%s"',
				    self.gw_user, m[1]);
				S.gotoState('error');
				return;
			} else if ((m = line.match(EXIT_STATUS))) {
				self.gw_lastError = new mod_verror.VError(
				    'The remote command exited with status ' +
				    '%d unexpectedly', m[1]);
				S.gotoState('error');
				return;
			}
		}
	});
	S.on(this.gw_outls, 'line', function (line) {
		if (line.indexOf('"dropped-output"') !== -1) {
			var obj = JSON.parse(line);
			if (obj.type === 'dropped-output') {
				self.emit('bootstrap');
			}
		}
	});
	S.on(this.gw_kid, 'close', function (code) {
		self.scr_lastError = new Error(
		    'Child exited with status ' + code);
		S.gotoState('error');
	});
	S.on(this, 'stopAsserted', function () {
		S.gotoState('stopping');
	});
	S.on(process, 'exit', function () {
		S.gotoState('stopping');
	});
};

GerritEventStream.prototype.stop = function () {
	mod_assert.strictEqual(this.getState(), 'running');
	this.emit('stopAsserted');
};

GerritEventStream.prototype.state_stopping = function (S) {
	S.on(this.gw_kid, 'close', function (code) {
		S.gotoState('stopped');
	});
	mod_cproc.spawnSync('kill', [this.gw_kid.pid]);
};

GerritEventStream.prototype.state_stopped = function () {
	this.gw_kid = undefined;
};

GerritEventStream.prototype.state_error = function (S) {
	if (this.gw_kid)
		mod_cproc.spawnSync('kill', [this.gw_kid.pid]);
	this.gw_kid = undefined;
	var r = this.gw_retry;
	if (--r.count > 0) {
		var d = r.delay;
		r.delay *= 2;
		if (isFinite(r.maxDelay) && r.delay > r.maxDelay)
			r.delay = r.maxDelay;
		r.timeout *= 2;
		if (isFinite(r.maxTimeout) && r.timeout > r.maxTimeout)
			r.timeout = r.maxTimeout;
		S.timeout(d, function () {
			S.gotoState('spawning');
		});
		this.gw_log.error(this.gw_lastError,
		    'error in gerrit event-stream, retrying in %d ms', d);
	} else {
		this.emit('error', this.gw_lastError);
	}
};
