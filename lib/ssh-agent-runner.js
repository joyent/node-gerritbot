/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = SSHAgentRunner;

var mod_fsm = require('mooremachine');
var mod_sshagent = require('sshpk-agent');
var mod_sshpk = require('sshpk');
var mod_events = require('events');
var mod_fs = require('fs');
var mod_cproc = require('child_process');
var mod_util = require('util');
var mod_assert = require('assert-plus');
var mod_lstream = require('lstream');

/*JSSTYLED*/
var ENV_RE = /([A-Z][A-Z0-9_a-z]+)=([^;]+)(;|$)/g;
/*JSSTYLED*/
var PID_RE = /^echo Agent pid ([0-9]+);/;

function SSHAgentRunner(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.log, 'options.log');
	this.sar_kid = undefined;
	this.sar_log = opts.log.child({ component: 'ssh-agent' });
	this.sar_errls = undefined;
	this.sar_outls = undefined;
	this.sar_env = {};
	mod_fsm.FSM.call(this, 'starting');
}
mod_util.inherits(SSHAgentRunner, mod_fsm.FSM);

SSHAgentRunner.prototype.getSocket = function () {
	mod_assert.strictEqual(this.getState(), 'running',
	    'agent must be running');
	mod_assert.string(this.sar_env['SSH_AUTH_SOCK'],
	    'SSH_AUTH_SOCK from child output');
	return (this.sar_env['SSH_AUTH_SOCK']);
};

SSHAgentRunner.prototype.makeClient = function () {
	mod_assert.strictEqual(this.getState(), 'running',
	    'agent must be running');
	mod_assert.string(this.sar_env['SSH_AUTH_SOCK'],
	    'SSH_AUTH_SOCK from child output');
	return (new mod_sshagent.Client({
		socketPath: this.sar_env['SSH_AUTH_SOCK']
	}));
};

SSHAgentRunner.prototype.state_starting = function (S) {
	var self = this;
	this.sar_errls = new mod_lstream();
	this.sar_outls = new mod_lstream();

	this.sar_kid = mod_cproc.spawn('ssh-agent', ['-Ds']);
	this.sar_kid.stdin.end();
	this.sar_kid.stderr.pipe(this.sar_errls);
	this.sar_kid.stdout.pipe(this.sar_outls);

	S.on(this.sar_errls, 'data', function (line) {
		self.sar_log.error(line);
	});
	S.on(this.sar_outls, 'data', function (line) {
		var re = new RegExp(ENV_RE);
		var m;
		while ((m = re.exec(line)) !== null) {
			self.sar_env[m[1]] = m[2];
		}
		m = line.match(PID_RE);
		if (m !== null) {
			if (parseInt(m[1], 10) != self.sar_kid.pid) {
				self.sar_log.warn('we forked %d, but the ' +
				    'agent says it has pid %d. kill ' +
				    'might fail later',
				    self.sar_kid.pid, parseInt(m[1], 10));
			}
			S.gotoState('running');
		}
	});
	S.on(this.sar_kid, 'close', function (status) {
		self.sar_log.error({ exitStatus: status },
		    'ssh-agent died early');
		S.gotoState('error');
	});
};

SSHAgentRunner.prototype.state_running = function (S) {
	var self = this;
	S.on(this.sar_errls, 'data', function (line) {
		self.sar_log.error(line);
	});
	S.on(this.sar_kid, 'close', function (status) {
		self.sar_log.error({ exitStatus: status },
		    'ssh-agent died early');
		S.gotoState('error');
	});
	S.on(process, 'exit', function () {
		S.gotoState('killing');
	});
};

SSHAgentRunner.prototype.state_error = function (S) {
	mod_cproc.spawnSync('kill', [this.sar_kid.pid]);
	this.emit('error', new Error('ssh-agent died unexpectedly'));
	S.gotoState('stopped');
};

SSHAgentRunner.prototype.state_killing = function (S) {
	S.on(this.sar_kid, 'close', function (status) {
		S.gotoState('stopped');
	});
	mod_cproc.spawnSync('kill', [this.sar_kid.pid]);
};

SSHAgentRunner.prototype.state_stopped = function () {
};
