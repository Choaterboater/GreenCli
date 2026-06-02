// Network-intent "assurance packs" derived from Juniper Validated Designs (JVDs)
// and equivalent Aruba fabric health checks. Each pack is a set of starter intent
// templates (a command + a matcher) the user can add with one click and then edit.
//
// The matchers are intentionally simple (whole-output contains / regex) and meant
// as a starting point — refine the command/value for your platform + software.

import { MatcherKind } from '../utils/intent';

export interface IntentTemplate {
  name: string;
  kind: 'config' | 'operational';
  command: string;
  matcher: { kind: MatcherKind; value: string };
  severity: 'critical' | 'warning' | 'info';
  description?: string;
}

export interface IntentPack {
  id: string;
  name: string;
  vendor: 'juniper' | 'aruba';
  /** Default scope device types for intents added from this pack. */
  deviceTypes: string[];
  description: string;
  templates: IntentTemplate[];
}

export const INTENT_PACKS: IntentPack[] = [
  {
    id: 'jvd-evpn-vxlan-dc',
    name: 'EVPN-VXLAN Data Center Fabric',
    vendor: 'juniper',
    deviceTypes: ['juniper-junos'],
    description: 'JVD IP fabric + EVPN-VXLAN overlay health (QFX/PTX leaf-spine).',
    templates: [
      { name: 'BGP underlay — no down peers', kind: 'operational', severity: 'critical', command: 'show bgp summary', matcher: { kind: 'regexAbsent', value: '\\b(Active|Connect|Idle|OpenSent|OpenConfirm)\\b' }, description: 'No underlay BGP session stuck below Established.' },
      { name: 'EVPN overlay routes present', kind: 'operational', severity: 'critical', command: 'show route table bgp.evpn.0 summary', matcher: { kind: 'regexAbsent', value: '0 destinations' }, description: 'bgp.evpn.0 has learned routes.' },
      { name: 'VXLAN remote VTEPs up', kind: 'operational', severity: 'warning', command: 'show ethernet-switching vxlan-tunnel-end-point remote', matcher: { kind: 'contains', value: 'RVTEP' }, description: 'Remote VTEPs are present.' },
      { name: 'EVPN database populated', kind: 'operational', severity: 'warning', command: 'show evpn database', matcher: { kind: 'regexAbsent', value: '0 entries' }, description: 'MAC/IP entries learned in the EVPN database.' },
      { name: 'No interface input errors', kind: 'operational', severity: 'warning', command: 'show interfaces extensive | match "errors:"', matcher: { kind: 'regexAbsent', value: 'errors:\\s*[1-9]' }, description: 'No non-zero interface error counters.' },
    ],
  },
  {
    id: 'jvd-ai-roce-fabric',
    name: 'AI / GPU RoCE Fabric',
    vendor: 'juniper',
    deviceTypes: ['juniper-junos'],
    description: 'JVD AI data-center lossless Ethernet (RoCEv2: PFC + ECN, no drops).',
    templates: [
      { name: 'PFC configured', kind: 'config', severity: 'critical', command: 'show configuration class-of-service', matcher: { kind: 'contains', value: 'pfc' }, description: 'Priority-flow-control present in CoS config.' },
      { name: 'ECN (congestion notification) configured', kind: 'config', severity: 'warning', command: 'show configuration class-of-service', matcher: { kind: 'contains', value: 'congestion-notification' }, description: 'ECN marking configured for RoCE queues.' },
      { name: 'No tail drops on lossless queues', kind: 'operational', severity: 'warning', command: 'show interfaces queue | match "Tail-dropped"', matcher: { kind: 'regexAbsent', value: 'Tail-dropped packets\\s*:\\s*[1-9]' }, description: 'No tail-dropped packets (lossless intent).' },
      { name: 'No excessive MAC pause frames', kind: 'operational', severity: 'info', command: 'show interfaces extensive | match "MAC pause"', matcher: { kind: 'regexAbsent', value: 'pause frames\\s*:\\s*[1-9]\\d{4,}' }, description: 'Pause frames are not storming (heuristic).' },
    ],
  },
  {
    id: 'jvd-evpn-campus',
    name: 'EVPN Campus (EX + Mist)',
    vendor: 'juniper',
    deviceTypes: ['juniper-junos'],
    description: 'JVD EVPN campus fabric: overlay up, VLANs/VNIs mapped, uplinks healthy.',
    templates: [
      { name: 'EVPN/BGP overlay — no down peers', kind: 'operational', severity: 'critical', command: 'show bgp summary', matcher: { kind: 'regexAbsent', value: '\\b(Active|Connect|Idle)\\b' }, description: 'Campus EVPN sessions Established.' },
      { name: 'VLAN ↔ VNI mappings present', kind: 'config', severity: 'warning', command: 'show configuration vlans | match vxlan', matcher: { kind: 'contains', value: 'vni' }, description: 'VLANs mapped to VXLAN VNIs.' },
      { name: 'Uplinks up', kind: 'operational', severity: 'warning', command: 'show interfaces terse | match "ae|et-|xe-"', matcher: { kind: 'regexAbsent', value: '\\bdown\\b' }, description: 'No fabric/uplink interface down.' },
    ],
  },
  {
    id: 'aruba-cx-fabric',
    name: 'Aruba CX Fabric Health',
    vendor: 'aruba',
    deviceTypes: ['aruba-cx'],
    description: 'AOS-CX VSX + fabric health (parity with the Juniper packs).',
    templates: [
      { name: 'VSX in-sync', kind: 'operational', severity: 'critical', command: 'show vsx status', matcher: { kind: 'contains', value: 'In-Sync' }, description: 'VSX peers synchronized.' },
      { name: 'BGP — no down peers', kind: 'operational', severity: 'critical', command: 'show bgp all summary', matcher: { kind: 'regexAbsent', value: '\\b(Active|Connect|Idle|OpenSent)\\b' }, description: 'All BGP sessions Established.' },
      { name: 'No interface errors', kind: 'operational', severity: 'warning', command: 'show interface error-statistics', matcher: { kind: 'regexAbsent', value: '\\b[1-9]\\d*\\b' }, description: 'No non-zero error counters (heuristic).' },
    ],
  },
];
