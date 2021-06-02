/*    Copyright 2016-2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sysManager = require('../net2/SysManager.js');
const Mode = require('../net2/Mode.js')
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();
const networkProfileManager = require('../net2/NetworkProfileManager')
const IdentityManager = require('../net2/IdentityManager.js');
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();
const timeSeries = require("../util/TimeSeries.js").getTimeSeries()
const Constants = require('../net2/Constants.js');
const l2 = require('../util/Layer2.js');
const fc = require('../net2/config.js')
const features = require('../net2/features.js')
const conntrack = platform.isAuditLogSupported() && features.isOn('conntrack') ?
  require('../net2/Conntrack.js') : { has: () => {} }
const LogReader = require('../util/LogReader.js');

const {Address4, Address6} = require('ip-address');
const exec = require('child-process-promise').exec;
const _ = require('lodash')

const LOG_PREFIX = "[FW_ACL_AUDIT]";
const SECLOG_PREFIX = "[FW_SEC_AUDIT]";

const auditLogFile = "/alog/acl-audit.log";
const dnsmasqLog = "/alog/dnsmasq-acl.log"

class ACLAuditLogPlugin extends Sensor {
  constructor(config) {
    super(config)

    this.featureName = "acl_audit";
    this.buffer = { }
    this.bufferTs = Date.now() / 1000
  }

  hookFeature() {
    if (platform.isAuditLogSupported()) super.hookFeature()
  }

  async run() {
    this.hookFeature();
    this.auditLogReader = null;
    this.dnsmasqLogReader = null
    this.aggregator = null
  }

  async job() {
    super.job()

    this.auditLogReader = new LogReader(auditLogFile);
    this.auditLogReader.on('line', this._processIptablesLog.bind(this));
    this.auditLogReader.watch();

    this.dnsmasqLogReader = new LogReader(dnsmasqLog);
    this.dnsmasqLogReader.on('line', this._processDnsmasqLog.bind(this));
    this.dnsmasqLogReader.watch();

    sem.on(Message.MSG_ACL_DNS, message => {
      if (message && message.record)
        this._processDnsRecord(message.record)
          .catch(err => log.error('Failed to process record', err, message.record))
    });
  }

  getDescriptor(r) {
    return r.type == 'dns' ?
      `dns:${r.dn}:${r.qc}:${r.qt}:${r.rc}` :
      `ip:${r.fd == 'out' ? r.sh : r.dh}:${r.dp}:${r.fd}`
  }

  writeBuffer(mac, record) {
    if (!this.buffer[mac]) this.buffer[mac] = {}
    const descriptor = this.getDescriptor(record)
    if (this.buffer[mac][descriptor]) {
      const s = this.buffer[mac][descriptor]
      // _.min() and _.max() will ignore non-number values
      s.ts = _.min([s.ts, record.ts])
      s.ets = _.max([s.ts, s.ets, record.ts, record.ets])
      s.ct += record.ct
      if (s.sp) s.sp = _.uniq(s.sp, record.sp)
    } else {
      this.buffer[mac][descriptor] = record
    }
  }

  // Jul  2 16:35:57 firewalla kernel: [ 6780.606787] [FW_ACL_AUDIT]IN=br0 OUT=eth0 PHYSIN=eth1.999 MAC=20:6d:31:fe:00:07:88:e9:fe:86:ff:94:08:00 SRC=192.168.210.191 DST=23.129.64.214 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=63349 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x87
  // THIS MIGHT BE A BUG: The calculated timestamp seems to always have a few seconds gap with real event time, but the gap is constant. The readable time seem to be accurate, but precision is not enough for event order distinguishing
  async _processIptablesLog(line) {
    if (_.isEmpty(line)) return

    // log.debug(line)
    const ts = new Date() / 1000;
    const secTagIndex = line.indexOf(SECLOG_PREFIX)
    const security = secTagIndex > 0
    // extract content after log prefix
    const content = line.substring(security ?
      secTagIndex + SECLOG_PREFIX.length : line.indexOf(LOG_PREFIX) + LOG_PREFIX.length
    );
    if (!content || content.length == 0)
      return;
    const params = content.split(' ');
    const record = { ts, type: 'ip', ct: 1};
    if (security) record.sec = 1
    let mac, srcMac, dstMac, inIntf, outIntf, intf, localIP, localIPisV4
    for (const param of params) {
      const kvPair = param.split('=');
      if (kvPair.length !== 2 || kvPair[1] == '')
        continue;
      const k = kvPair[0];
      const v = kvPair[1];
      switch (k) {
        case "SRC": {
          record.sh = v;
          break;
        }
        case "DST": {
          record.dh = v;
          break;
        }
        case "PROTO": {
          record.pr = v.toLowerCase();
          // ignore icmp packets
          if (record.pr == 'icmp') return
          break;
        }
        case "SPT": {
          record.sp = [ Number(v) ];
          break;
        }
        case "DPT": {
          record.dp = Number(v);
          break;
        }
        case 'MAC': {
          dstMac = v.substring(0, 17).toUpperCase()
          srcMac = v.substring(18, 35).toUpperCase()
          break;
        }
        case 'IN': {
          inIntf = sysManager.getInterface(v)
          break;
        }
        case 'OUT': {
          // when dropped before routing, there's no out interface
          outIntf = sysManager.getInterface(v)
          break;
        }
        default:
      }
    }

    // v6 address in iptables log is full representation, e.g. 2001:0db8:85a3:0000:0000:8a2e:0370:7334
    const srcIsV4 = new Address4(record.sh).isValid()
    if (!srcIsV4) record.sh = new Address6(record.sh).correctForm()
    const dstIsV4 = new Address4(record.dh).isValid()
    if (!dstIsV4) record.dh = new Address6(record.dh).correctForm()

    if (sysManager.isMulticastIP(record.dh, outIntf && outIntf.name || inIntf.name, false)) return

    // check direction, keep it same as flow.fd
    // in, initiated from inside
    // out, initated from outside

    if (await Mode.isRouterModeOn()) {
      if (inIntf.type == 'lan') {
        intf = inIntf
        record.fd = outIntf && outIntf.type == 'lan' ? 'lo' : 'in'
      } else if (outIntf && outIntf.type == 'wan') {
        // this should not happen in router mode
        log.error('Neither IP is local, something is wrong', line)
        return
      } else {
        // in => wan && (out => lan or N/A)
        record.fd = 'out';
        if (outIntf && outIntf.type == 'lan') {
          intf = outIntf
        } else {
          intf = inIntf
          // ignores WAN block if there's recent connection to the same remote host & port
          // this solves issue when packets come after local conntrack times out
          if (record.sp && conntrack.has('tcp', `${record.sh}:${record.sp[0]}`)) return
        }
      }
    } else {
      // for non-router modes, interface alone isn't enough to state the traffic direction, checking IPs
      const srcIsLocal = sysManager.isLocalIP(record.sh)
      const dstIsLocal = sysManager.isLocalIP(record.dh)

      if (srcIsLocal) {
        intf = inIntf
        if (dstIsLocal)
          record.fd = 'lo';
        else
          record.fd = 'in';
      } else if (dstIsLocal) {
        intf = outIntf
        record.fd = 'out';
      } else {
        log.error('Neither IP is local, something is wrong', line)
        return
      }
    }

    if (record.fd == 'out') {
      mac = dstMac;
      localIP = record.dh
      localIPisV4 = dstIsV4
    } else {
      mac = srcMac;
      localIP = record.sh
      localIPisV4 = srcIsV4
    }

    record.intf = intf.uuid

    if (!localIP) {
      log.error('No local IP', line)
    }

    // broadcast mac address
    if (mac == 'FF:FF:FF:FF:FF:FF') return

    const identity = IdentityManager.getIdentityByIP(localIP);
    if (identity) {
      if (!platform.isFireRouterManaged())
        return;
      mac = IdentityManager.getGUID(identity);
      record.rl = IdentityManager.getEndpointByIP(localIP);
    }
    // local IP being Firewalla's own interface, use if:<uuid> as "mac"
    else if (localIPisV4 ?
      sysManager.isMyIP(localIP, false) :
      sysManager.isMyIP6(localIP, false)
    ) {
      mac = `${Constants.NS_INTERFACE}:${intf.uuid}`
    }
    // not Firewalla's IP, try resolve to device mac
    else if (!mac || mac == intf.mac_address.toUpperCase()) {
      mac = localIPisV4 && await l2.getMACAsync(localIP).catch(err => {
              log.error("Failed to get MAC address from link layer for", localIP, err);
            })
         || await hostTool.getMacByIPWithCache(localIP).catch(err => {
              log.error("Failed to get MAC address from SysManager for", localIP, err);
            })
         || `${Constants.NS_INTERFACE}:${intf.uuid}`
    }
    // mac != intf.mac_address => mac is device mac, keep mac unchanged

    this.writeBuffer(mac, record)
  }

  async _processDnsRecord(record) {
    record.type = 'dns'
    record.pr = 'dns'

    const intf = new Address4(record.sh).isValid() ?
      sysManager.getInterfaceViaIP4(record.sh, false) :
      sysManager.getInterfaceViaIP6(record.sh, false)

    if (!intf) {
      log.debug('Interface not found for', record.sh);
      return null
    }

    record.intf = intf.uuid

    let mac = record.mac;
    // first try to get mac from device database
    if (!mac || mac === "FF:FF:FF:FF:FF:FF" || ! (await hostTool.getMACEntry(mac))) {
      if (record.sh)
        mac = await hostTool.getMacByIPWithCache(record.sh);
    }
    // then try to get guid from IdentityManager, because it is more CPU intensive
    if (!mac) {
      const identity = IdentityManager.getIdentityByIP(record.sh);
      if (identity) {
        if (!platform.isFireRouterManaged())
          return;
        mac = IdentityManager.getGUID(identity);
        record.rl = IdentityManager.getEndpointByIP(record.sh);
      }
    }

    if (!mac) {
      log.debug('MAC address not found for', record.sh)
      return
    }

    record.ct = 1;

    this.writeBuffer(mac, record)
  }

  // line example
  // [Blocked]ts=1620435648 mac=68:54:5a:68:e4:30 sh=192.168.154.168 sh6= dn=hometwn-device-api.coro.net
  // [Blocked]ts=1620435648 mac=68:54:5a:68:e4:30 sh= sh6=2001::1234:0:0:567:ff dn=hometwn-device-api.coro.net
  async _processDnsmasqLog(line) {
    if (line) {
      let recordArr;
      const record = {};
      record.dp = 53;
      if (line.includes("[Blocked]")) {
        recordArr = line.substr(line.indexOf("[Blocked]") + 9).split(' ');
        record.rc = 3; // dns block's return code is 3
      } else if (fc.isFeatureOn("dnsmasq_log_allow") && line.includes("[Allowed]")) {
        recordArr = line.substr(line.indexOf("[Allowed]") + 9).split(' ');
      }
      if (!recordArr || !Array.isArray(recordArr)) return;
      for (const param of recordArr) {
        const kv = param.split("=")
        if (kv.length != 2) continue;
        const k = kv[0]; const v = kv[1];
        if (!_.isEmpty(v)) {
          switch(k) {
            case "ts":
              record.ts = Number(v);
              break;
            case "mac":
              record.mac = v.toUpperCase();
              break;
            case "sh":
              record.sh = v;
              record.qt = 1;
              break;
            case "sh6":
              record.sh = v;
              record.qt = 28;
              break;
            case "dn":
              if (v.endsWith("]")) {
                record.dn = v.substring(0, v.length - 1);
              } else {
                record.dn = v;
              }
              break;
            default:
          }
        }
      }
      this._processDnsRecord(record);
    }
  }

  _getAuditKey(mac, block = true) {
    return block ? `audit:drop:${mac}` : `audit:accept:${mac}`;
  }

  async writeLogs() {
    try {
      log.debug('Start writing logs', this.bufferTs)
      // log.debug(JSON.stringify(this.buffer))

      const buffer = this.buffer
      this.buffer = { }
      log.debug(buffer)

      for (const mac in buffer) {
        for (const descriptor in buffer[mac]) {
          const record = buffer[mac][descriptor];
          const {type, ts, ets, ct, intf} = record
          const _ts = ets || ts
          const block = type == 'dns' ?
            record.rc == 3 /*NXDOMAIN*/ &&
            (record.qt == 1 /*A*/ || record.qt == 28 /*AAAA*/ ) &&
            record.dp == 53
            :
            true
          const tags = []
          if (
            !IdentityManager.isGUID(mac) &&
            !mac.startsWith(Constants.NS_INTERFACE + ':')
          ) {
            const host = hostManager.getHostFastByMAC(mac);
            if (host) tags.push(...await host.getTags())
          }
          const networkProfile = networkProfileManager.getNetworkProfile(intf);
          if (networkProfile) tags.push(...networkProfile.getTags());
          record.tags = _.uniq(tags)

          const key = this._getAuditKey(mac, block)
          await rclient.zaddAsync(key, _ts, JSON.stringify(record));

          const expires = this.config.expires || 86400
          await rclient.expireatAsync(key, parseInt(new Date / 1000) + expires)

          const hitType = type + (block ? 'B' : '')
          timeSeries.recordHit(`${hitType}`, _ts, ct)
          timeSeries.recordHit(`${hitType}:${mac}`, _ts, ct)
          timeSeries.recordHit(`${hitType}:intf:${intf}`, _ts, ct)
          for (const tag of record.tags) {
            timeSeries.recordHit(`${hitType}:tag:${tag}`, _ts, ct)
          }
        }
      }
      timeSeries.exec()
    } catch(err) {
      log.error("Failed to write audit logs", err)
    }
  }

  // Works similar to flowStash in BroDetect, reduce memory is the main purpose here
  async mergeLogs(startOpt, endOpt) {
    try {
      const end = endOpt || Math.floor(new Date() / 1000 / this.config.interval) * this.config.interval
      const start = startOpt || end - this.config.interval
      log.debug('Start merging', start, end)

      for (const block of [true, false]) {
        const auditKeys = await rclient.scanResults(this._getAuditKey('*', block), 1000)
        log.debug('Key(mac) count: ', auditKeys.length)
        for (const key of auditKeys) {
          const records = await rclient.zrangebyscoreAsync(key, start, end)
          // const mac = key.substring(11) // audit:drop:<mac>

          const stash = {}
          for (const recordString of records) {
            try {
              const record = JSON.parse(recordString)
              const descriptor = this.getDescriptor(record)

              if (stash[descriptor]) {
                const s = stash[descriptor]
                // _.min() and _.max() will ignore non-number values
                s.ts = _.min([s.ts, record.ts])
                s.ets = _.max([s.ts, s.ets, record.ts, record.ets])
                s.ct += record.ct
                if (s.sp) s.sp = _.uniq(s.sp, record.sp)
              } else {
                stash[descriptor] = record
              }
            } catch(err) {
              log.error('Failed to process record', err, recordString)
            }
          }

          const transaction = [];
          transaction.push(['zremrangebyscore', key, start, end]);
          for (const descriptor in stash) {
            const record = stash[descriptor]
            transaction.push(['zadd', key, record.ets || record.ts, JSON.stringify(record)])
          }
          const expires = this.config.expires || 86400
          await rclient.expireatAsync(key, parseInt(new Date / 1000) + expires)
          transaction.push(['expireat', key, parseInt(new Date / 1000) + this.config.expires])

          // catch this to proceed onto the next iteration
          try {
            log.debug(transaction)
            await rclient.multi(transaction).execAsync();
            log.debug("Audit:Save:Removed", key);
          } catch (err) {
            log.error("Audit:Save:Error", err);
          }
        }
      }

    } catch(err) {
      log.error("Failed to merge audit logs", err)
    }
  }

  async globalOn() {
    super.globalOn()

    await exec(`${f.getFirewallaHome()}/scripts/audit-run`)

    this.bufferDumper = this.bufferDumper || setInterval(this.writeLogs.bind(this), (this.config.buffer || 30) * 1000)
    this.aggregator = this.aggregator || setInterval(this.mergeLogs.bind(this), (this.config.interval || 300) * 1000)

    await exec(`${f.getFirewallaHome()}/scripts/dnsmasq-log on`);
  }

  async globalOff() {
    super.globalOff()

    await exec(`${f.getFirewallaHome()}/scripts/audit-stop`)

    clearInterval(this.bufferDumper)
    clearInterval(this.aggregator)
    this.bufferDumper = this.aggregator = undefined

    await exec(`${f.getFirewallaHome()}/scripts/dnsmasq-log off`);
  }

}

module.exports = ACLAuditLogPlugin;
