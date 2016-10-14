/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = SSHCmdRunner;

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
var mod_bunyan = require('bunyan');

function SSHCmdRunner(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.agentRunner, 'options.agentRunner');
	mod_assert.string(opts.user, 'options.user');
	mod_assert.string(opts.host, 'options.host');
	mod_assert.optionalNumber(opts.port, 'options.port');
	mod_assert.object(opts.log, 'options.log');
	mod_assert.object(opts.recovery, 'options.recovery');
	mod_assert.arrayOfString(opts.args, 'options.args');

	var recovery = opts.recovery.gerrit;
	if (recovery === undefined)
		recovery = opts.recovery.default;
	this.scr_retry = {
		max: recovery.retries,
		count: recovery.retries,
		timeout: recovery.timeout,
		maxTimeout: recovery.maxTimeout || Infinity,
		delay: recovery.delay,
		maxDelay: recovery.maxDelay || Infinity
	};

	this.scr_agentRunner = opts.agentRunner;
	this.scr_user = opts.user;
	this.scr_port = opts.port;
	if (this.scr_port === undefined)
		this.scr_port = 22;
	this.scr_host = opts.host;
	this.scr_tokill = [];
	this.scr_log = opts.log.child({ component: 'cmd-runner' });

	this.scr_args = opts.args;

	this.scr_kid = undefined;
	this.scr_errls = new mod_lstream();
	this.scr_debugls = new mod_lstream();
	this.scr_outls = new mod_lstream();

	this.scr_fifo = undefined;
	this.scr_exitStatus = undefined;

	mod_fsm.FSM.call(this, 'waitagent');
}
mod_util.inherits(SSHCmdRunner, mod_fsm.FSM);

Object.defineProperty(SSHCmdRunner.prototype, 'stdout', {
	get: function () {
		return (this.scr_outls);
	}
});

Object.defineProperty(SSHCmdRunner.prototype, 'stderr', {
	get: function () {
		return (this.scr_errls);
	}
});

Object.defineProperty(SSHCmdRunner.prototype, 'stdin', {
	get: function () {
		return (this.scr_kid.stdin);
	}
});

SSHCmdRunner.prototype.state_waitagent = function (S) {
	if (this.scr_agentRunner.isInState('running')) {
		S.gotoState('spawning');
	} else {
		S.on(this.scr_agentRunner, 'stateChanged', function (st) {
			if (st === 'running')
				S.gotoState('spawning');
		});
	}
};

var BAD_AUTH = /^Permission denied/;
var CMD_START = /^debug1: Sending command: gerrit/;
/*JSSTYLED*/
var EXIT_STATUS = /^debug1: Exit status ([0-9-]+)/;

SSHCmdRunner.prototype.state_spawning = function (S) {
	var self = this;

	var seed = mod_crypto.randomBytes(8).toString('hex');
	this.scr_fifo = '/tmp/gerrit-ssh.debug.' + seed;
	var ret = mod_cproc.spawnSync('mkfifo', [this.scr_fifo]);
	if (ret.status !== 0) {
		this.scr_log.error({ output: ret.stderr },
		    'failed to mkfifo');
		S.gotoState('retry');
		return;
	}

	var opts = {};
	opts.env = {};
	opts.env.SSH_AUTH_SOCK = this.scr_agentRunner.getSocket();
	opts.env.PATH = process.env.PATH;

	this.scr_kid = mod_cproc.spawn('ssh',
	    ['-v', '-p', this.scr_port,
	    '-E', this.scr_fifo,
	    '-o', 'ServerAliveInterval=10',
	    '-o', 'ServerAliveCountMax=1',
	    this.scr_user + '@' + this.scr_host,
	    'gerrit'].concat(this.scr_args), opts);
	this.scr_log.trace({ args: this.scr_args },
	    'spawned ssh for gerrit cmd in pid %d',
	    this.scr_kid.pid);

	S.on(this.scr_kid, 'error', function (err) {
		self.scr_lastError = err;
		S.gotoState('retry');
	});

	this.scr_fifoStream = mod_fs.createReadStream(this.scr_fifo);
	this.scr_fifoStream.pipe(this.scr_debugls, { end: false });

	this.scr_kid.stderr.pipe(this.scr_errls, { end: false });
	this.scr_kid.stdout.pipe(this.scr_outls, { end: false });

	S.on(this.scr_debugls, 'readable', function () {
		var line;
		while ((line = self.scr_debugls.read()) !== null) {
			var m;
			if (line.match(BAD_AUTH)) {
				self.scr_lastError = new Error(
				    'Failed to authenticate to gerrit SSH');
				S.gotoState('error');
				return;
			} else if ((m = line.match(CMD_START))) {
				S.gotoState('running');
				return;
			}
		}
	});

	S.on(this.scr_kid, 'close', function (code) {
		self.scr_lastError = new mod_verror.VError(
		    'SSH exited early with status %d', code);
		S.gotoState('retry');
	});

	S.timeout(this.scr_retry.timeout, function () {
		self.scr_lastError = new Error(
		    'Timed out waiting for command to start');
		S.gotoState('retry');
	});
};

SSHCmdRunner.prototype.state_running = function (S) {
	var lastErr = [];
	var lastDebug = [];
	var self = this;
	S.on(this.scr_errls, 'line', function (line) {
		lastErr.push(line);
		if (lastErr.length > 5)
			lastErr.shift();
	});
	S.on(this.scr_debugls, 'readable', function () {
		var line, m;
		while ((line = self.scr_errls.read()) !== null) {
			if ((m = line.match(EXIT_STATUS)))
				self.scr_exitStatus = parseInt(m[1], 10);
			lastDebug.push(line);
			if (lastDebug.length > 5)
				lastDebug.shift();
		}
	});
	S.on(this.scr_kid, 'close', function (code) {
		if (code === 255) {
			self.scr_lastError = new mod_verror.VError(
			    'SSH returned error (exit status 255):\n\t\t%s',
			    lastErr.join('\n\t\t'));
			S.gotoState('error');
			return;
		}
		if (self.scr_exitStatus === undefined)
			self.scr_exitStatus = code;
		if (self.scr_exitStatus !== 0) {
			var err = lastErr;
			if (err.length < 1)
				err = lastDebug;
			self.scr_lastError = new mod_verror.VError(
			    'gerrit command exited with status %d\n\t\t%s',
			    self.scr_exitStatus, err.join('\n\t\t'));
			S.gotoState('error');
			return;
		}
		S.gotoState('finished');
	});
	S.on(process, 'exit', function () {
		S.gotoState('stopped');
	});
};

SSHCmdRunner.prototype.state_finished = function () {
	this.emit('finished');
	if (this.scr_fifo)
		mod_fs.unlinkSync(this.scr_fifo);
	this.scr_fifo = undefined;
	this.scr_errls.end();
	this.scr_debugls.end();
	this.scr_outls.end();
};

SSHCmdRunner.prototype.state_error = function () {
	if (this.scr_kid)
		mod_cproc.spawnSync('kill', [this.scr_kid.pid]);
	if (this.scr_fifo)
		mod_fs.unlinkSync(this.scr_fifo);
	this.scr_kid = undefined;
	this.scr_fifo = undefined;
	this.emit('error', this.scr_lastError);
};

SSHCmdRunner.prototype.state_stopped = function () {
	if (this.scr_kid)
		mod_cproc.spawnSync('kill', [this.scr_kid.pid]);
	if (this.scr_fifo)
		mod_fs.unlinkSync(this.scr_fifo);
	this.scr_kid = undefined;
};

SSHCmdRunner.prototype.state_retry = function (S) {
	if (this.scr_kid)
		mod_cproc.spawnSync('kill', [this.scr_kid.pid]);
	if (this.scr_fifo)
		mod_fs.unlinkSync(this.scr_fifo);
	this.scr_kid = undefined;
	this.scr_fifo = undefined;
	var r = this.scr_retry;
	if (--r.count > 0) {
		var d = r.delay;
		r.delay *= 2;
		if (isFinite(r.maxDelay) && r.delay > r.maxDelay)
			r.delay = r.maxDelay;
		r.timeout *= 2;
		if (isFinite(r.maxTimeout) && r.timeout > r.maxTimeout)
			r.timeout = r.maxTimeout;
		this.scr_log.warn(this.scr_lastError,
		    'retryable error in gerrit cmd, retrying in %d ms', d);
		S.timeout(d, function () {
			S.gotoState('spawning');
		});
	} else {
		this.emit('error', this.scr_lastError);
	}
};
