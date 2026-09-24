import { isIP } from 'node:net';

const bool = v => /^(true|false)$/.test(v);
const address = (v, version) => {
  if (['none','auto'].includes(v)) return true;
  const parts = v.split('/');
  return parts.length === 2 && isIP(parts[0]) === version && /^\d+$/.test(parts[1]) && Number(parts[1]) <= (version === 4 ? 32 : 128);
};
const keys = {
  'ipv4.address': v => address(v,4), 'ipv6.address': v => address(v,6),
  'ipv4.nat': bool, 'ipv6.nat': bool, 'ipv4.dhcp': bool, 'ipv6.dhcp': bool, 'ipv6.dhcp.stateful': bool,
  'ipv4.routing': bool, 'ipv6.routing': bool,
  'bridge.mtu': v => /^\d+$/.test(v) && Number(v)>=576 && Number(v)<=9000,
  'dns.mode': v => ['managed','dynamic','none'].includes(v),
  'dns.domain': v => v.length<=253 && /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(v),
  'ipv4.dhcp.ranges': v => v.split(',').every(range => { const p=range.trim().split('-'); return p.length===2 && p.every(ip=>isIP(ip)===4); }),
};
export function networkConfigArgv(name, config, { unset=false }={}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name)) throw new Error('Invalid network name');
  if (!config || typeof config!=='object' || Array.isArray(config) || !Object.keys(config).length || Object.keys(config).length>32) throw new Error('A supported network configuration is required');
  return Object.entries(config).map(([key,value])=>{
    if (!Object.hasOwn(keys,key)) throw new Error(`Unsupported network key: ${key}`);
    if (!unset && (typeof value!=='string' || !keys[key](value))) throw new Error(`Invalid value for ${key}`);
    return unset ? ['network','unset',name,key] : ['network','set',name,key,value];
  });
}
