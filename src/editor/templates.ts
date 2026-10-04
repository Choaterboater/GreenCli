// Config templates: whole starter configs that open in their own tab, in the
// right language. Values you must choose are ${name} blanks: Problems shows
// each one in red until it is filled, and Send safely turns them into
// per-device values. VLAN numbers and names are left as plain examples.
//
// None saves or commits by itself: the last comment says how (Send safely, or
// save by hand once it looks right).

export interface ConfigTemplate {
  label: string;
  /** The tab's language when the template opens. */
  language: string;
  body: string;
}

const CX_END = '! Use Send safely (rollback timer, saves after confirm). Or save once it looks right: write memory\n';
const AOSS_END =
  '! AOS-S has no rollback timer: check the management VLAN/IP and your own port first. Save once it looks right: write memory\n';
const JUNOS_END =
  '/* Review: show | compare. Then use Send safely (arrow next to Send): it commits with a rollback timer and confirms for you. */\n';

export const CONFIG_TEMPLATES: readonly ConfigTemplate[] = [
  {
    label: 'AOS-CX: VLANs',
    language: 'aruba-cx',
    body: `! VLAN Configuration
configure terminal
vlan 10
  name MGMT
vlan 20
  name USERS
vlan 30
  name GUEST
vlan 100
  name VOICE
end
${CX_END}`,
  },
  {
    label: 'AOS-CX: Trunk port',
    language: 'aruba-cx',
    body: `! Uplink trunk port
configure terminal
interface \${uplink}
  no shutdown
  no routing
  description Uplink-Core
  vlan trunk native 10
  vlan trunk allowed 10,20,30,100
end
${CX_END}`,
  },
  {
    label: 'AOS-CX: Access port',
    language: 'aruba-cx',
    body: `! Access ports (users), for example 1/1/3-1/1/48
configure terminal
interface \${access_ports}
  no shutdown
  no routing
  vlan access 20
end
${CX_END}`,
  },
  {
    label: 'AOS-CX: BGP peer',
    language: 'aruba-cx',
    body: `! BGP configuration
configure terminal
router bgp \${local_asn}
  bgp router-id \${router_id}
  neighbor \${peer_ip} remote-as \${peer_asn}
  neighbor \${peer_ip} description Core-Peer
  address-family ipv4 unicast
    neighbor \${peer_ip} activate
  exit-address-family
end
${CX_END}`,
  },
  {
    label: 'AOS-CX: OSPF',
    language: 'aruba-cx',
    body: `! OSPF on a routed point-to-point uplink, plus a loopback
configure terminal
router ospf 1
  router-id \${router_id}
  area 0.0.0.0
interface loopback 0
  ip address \${router_id}/32
  ip ospf 1 area 0.0.0.0
interface \${uplink}
  no shutdown
  routing
  ip address \${p2p_ip_cidr}
  ip ospf 1 area 0.0.0.0
  ip ospf network point-to-point
end
${CX_END}`,
  },
  {
    label: 'AOS-CX: AAA / RADIUS',
    language: 'aruba-cx',
    body: `! RADIUS login for the switch (vrf: mgmt or default)
! A wrong key or a user RADIUS rejects can lock you out: before you confirm or save,
! open a second SSH login to the switch and check it works.
configure terminal
radius-server host \${radius_ip} key plaintext \${radius_key} vrf \${vrf}
aaa group server radius \${group}
  server \${radius_ip} vrf \${vrf}
aaa authentication login default group \${group} local
aaa accounting all-mgmt default start-stop group \${group}
end
${CX_END}`,
  },
  {
    label: 'AOS-S: VLAN + tagged uplink',
    language: 'aruba-aos-s',
    body: `! Aruba AOS-S / ProVision
configure terminal
vlan 10
   name "MGMT"
   tagged \${uplink}
   ip address \${mgmt_ip} \${mgmt_mask}
   exit
vlan 20
   name "USERS"
   tagged \${uplink}
   untagged \${access_ports}
   exit
${AOSS_END}`,
  },
  {
    label: 'Aruba AP: WLAN basics',
    language: 'aruba-ap',
    body: `! Aruba Instant AP / VC
configure terminal
wlan ssid-profile Example-SSID
  enable
  essid Example-SSID
  opmode wpa2-psk-aes
  wpa-passphrase \${wpa_passphrase}
exit
! Plain Send: finish with commit apply (Send safely adds it for you)
`,
  },
  {
    label: 'AOS8: AP group WLAN',
    language: 'aruba-controller',
    body: `! ArubaOS 8 Controller / Conductor (node path, for example /md/Campus)
configure terminal
cd \${node_path}
wlan ssid-profile Example-SSID
  essid Example-SSID
  opmode wpa2-psk-aes
  wpa-passphrase \${wpa_passphrase}
exit
wlan virtual-ap Example-VAP
  ssid-profile Example-SSID
exit
ap-group \${ap_group}
  virtual-ap Example-VAP
exit
! Save once it looks right: write memory (on a Mobility Conductor this also pushes the change down)
`,
  },
  {
    label: 'Junos: VLANs',
    language: 'juniper-junos',
    body: `/* Juniper Junos — VLANs (set-style) */
configure
set vlans MGMT vlan-id 10
set vlans USERS vlan-id 20
set vlans GUEST vlan-id 30
set vlans VOICE vlan-id 100
${JUNOS_END}`,
  },
  {
    label: 'Junos: Trunk port',
    language: 'juniper-junos',
    body: `/* Junos — trunk uplink */
configure
set interfaces \${uplink} description Uplink-Core
set interfaces \${uplink} unit 0 family ethernet-switching interface-mode trunk
set interfaces \${uplink} unit 0 family ethernet-switching vlan members [ MGMT USERS GUEST VOICE ]
set interfaces \${uplink} native-vlan-id 10
${JUNOS_END}`,
  },
  {
    label: 'Junos: Access port',
    language: 'juniper-junos',
    body: `/* Junos — access port */
configure
set interfaces \${interface} unit 0 family ethernet-switching interface-mode access
set interfaces \${interface} unit 0 family ethernet-switching vlan members USERS
${JUNOS_END}`,
  },
  {
    label: 'Junos: BGP peer',
    language: 'juniper-junos',
    body: `/* Junos — BGP */
configure
set routing-options router-id \${router_id}
set routing-options autonomous-system \${local_asn}
set protocols bgp group EBGP type external
set protocols bgp group EBGP neighbor \${peer_ip} peer-as \${peer_asn}
set protocols bgp group EBGP neighbor \${peer_ip} description Core-Peer
${JUNOS_END}`,
  },
  {
    label: 'Junos: OSPF',
    language: 'juniper-junos',
    body: `/* Junos — OSPF on a routed point-to-point uplink, plus the loopback */
configure
set routing-options router-id \${router_id}
set interfaces lo0 unit 0 family inet address \${router_id}/32
set interfaces \${uplink} unit 0 family inet address \${p2p_ip_cidr}
set protocols ospf area 0.0.0.0 interface \${uplink}.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface lo0.0 passive
${JUNOS_END}`,
  },
  {
    label: 'Mist/Junos: access switch baseline',
    language: 'mist',
    body: `/* Mist-managed Junos switch baseline */
/* Mist overwrites local CLI changes on its next config push: make lasting changes in Mist. */
configure
set system host-name \${switch_name}
set system services ssh
set vlans USERS vlan-id 20
set interfaces \${interface} unit 0 family ethernet-switching interface-mode access
set interfaces \${interface} unit 0 family ethernet-switching vlan members USERS
${JUNOS_END}`,
  },

  // ─── Juniper Validated Design starters (Junos): fill the blanks, then check with commit check ───
  {
    label: 'JVD: EVPN-VXLAN leaf (ERB)',
    language: 'juniper-junos',
    body: `/* JVD EVPN-VXLAN — leaf (edge-routed bridging). A starter: fill the blanks, then run commit check. */
configure
set chassis aggregated-devices ethernet device-count 2
set routing-options router-id \${leaf_lo0}
set routing-options autonomous-system \${leaf_asn}
set interfaces lo0 unit 0 family inet address \${leaf_lo0}/32
set interfaces \${uplink} unit 0 family inet address \${p2p_ip_cidr}
set policy-options policy-statement LO0 term 1 from interface lo0.0
set policy-options policy-statement LO0 term 1 then accept
/* Underlay: eBGP to the spine */
set protocols bgp group UNDERLAY type external
set protocols bgp group UNDERLAY family inet unicast
set protocols bgp group UNDERLAY export LO0
set protocols bgp group UNDERLAY neighbor \${spine_p2p_ip} peer-as \${spine_asn}
/* Overlay: eBGP EVPN to the spine loopback */
set protocols bgp group OVERLAY type external
set protocols bgp group OVERLAY multihop ttl 2
set protocols bgp group OVERLAY local-address \${leaf_lo0}
set protocols bgp group OVERLAY family evpn signaling
set protocols bgp group OVERLAY neighbor \${spine_lo0} peer-as \${spine_asn}
/* EVPN-VXLAN */
set protocols evpn encapsulation vxlan
set protocols evpn default-gateway no-gateway-community
set protocols evpn extended-vni-list all
set switch-options vtep-source-interface lo0.0
set switch-options route-distinguisher \${leaf_lo0}:1
set switch-options vrf-target target:65000:1
set vlans V100 vlan-id 100
set vlans V100 vxlan vni 10100
${JUNOS_END}`,
  },
  {
    label: 'JVD: EVPN-VXLAN spine (eBGP)',
    language: 'juniper-junos',
    body: `/* JVD EVPN-VXLAN — spine (eBGP underlay + EVPN overlay). A starter: fill the blanks, then run commit check. */
configure
set routing-options router-id \${spine_lo0}
set routing-options autonomous-system \${spine_asn}
set interfaces lo0 unit 0 family inet address \${spine_lo0}/32
set interfaces \${downlink} unit 0 family inet address \${p2p_ip_cidr}
set policy-options policy-statement LO0 term 1 from interface lo0.0
set policy-options policy-statement LO0 term 1 then accept
set protocols bgp group UNDERLAY type external
set protocols bgp group UNDERLAY family inet unicast
set protocols bgp group UNDERLAY export LO0
set protocols bgp group UNDERLAY neighbor \${leaf_p2p_ip} peer-as \${leaf_asn}
set protocols bgp group OVERLAY type external
set protocols bgp group OVERLAY multihop no-nexthop-change
set protocols bgp group OVERLAY local-address \${spine_lo0}
set protocols bgp group OVERLAY family evpn signaling
set protocols bgp group OVERLAY neighbor \${leaf_lo0} peer-as \${leaf_asn}
${JUNOS_END}`,
  },
  {
    label: 'JVD: AI fabric RoCE QoS (PFC+ECN)',
    language: 'juniper-junos',
    body: `/* JVD AI/GPU fabric — lossless RoCEv2: PFC on DSCP 26 (011010), ECN marking. A starter: run commit check. */
configure
set class-of-service classifiers dscp ROCE forwarding-class NO-LOSS loss-priority low code-points 011010
set class-of-service classifiers dscp ROCE forwarding-class network-control loss-priority low code-points 110000
set class-of-service forwarding-classes class NO-LOSS queue-num 3 no-loss
set class-of-service congestion-notification-profile CNP input dscp code-point 011010 pfc
set class-of-service interfaces \${interface} congestion-notification-profile CNP
set class-of-service interfaces \${interface} unit 0 classifiers dscp ROCE
set class-of-service drop-profiles ECN-DP interpolate fill-level 30 drop-probability 0
set class-of-service drop-profiles ECN-DP interpolate fill-level 100 drop-probability 100
set class-of-service schedulers SCH-NOLOSS transmit-rate percent 50
set class-of-service schedulers SCH-NOLOSS buffer-size percent 50
set class-of-service schedulers SCH-NOLOSS explicit-congestion-notification
set class-of-service schedulers SCH-NOLOSS drop-profile-map loss-priority any protocol any drop-profile ECN-DP
/* Every class in use gets a scheduler: unmapped ones get no bandwidth, and BGP could flap. */
set class-of-service schedulers SCH-NC transmit-rate percent 10
set class-of-service schedulers SCH-NC buffer-size percent 10
set class-of-service schedulers SCH-BE transmit-rate percent 40
set class-of-service schedulers SCH-BE buffer-size percent 40
set class-of-service scheduler-maps SM-AI forwarding-class NO-LOSS scheduler SCH-NOLOSS
set class-of-service scheduler-maps SM-AI forwarding-class network-control scheduler SCH-NC
set class-of-service scheduler-maps SM-AI forwarding-class best-effort scheduler SCH-BE
set class-of-service interfaces \${interface} scheduler-map SM-AI
${JUNOS_END}`,
  },
  {
    label: 'JVD: EVPN campus access (EX)',
    language: 'juniper-junos',
    body: `/* JVD EVPN campus fabric — access switch as a VTEP. A starter: Mist usually builds this for you. */
configure
set chassis aggregated-devices ethernet device-count 1
set routing-options router-id \${lo0_ip}
set routing-options autonomous-system \${local_asn}
set interfaces lo0 unit 0 family inet address \${lo0_ip}/32
/* Uplink: two ports in a routed LACP bundle */
set interfaces \${member_1} ether-options 802.3ad ae0
set interfaces \${member_2} ether-options 802.3ad ae0
set interfaces ae0 aggregated-ether-options lacp active
set interfaces ae0 unit 0 family inet address \${p2p_ip_cidr}
set policy-options policy-statement LO0 term 1 from interface lo0.0
set policy-options policy-statement LO0 term 1 then accept
/* Underlay: eBGP to the distribution switch */
set protocols bgp group UNDERLAY type external
set protocols bgp group UNDERLAY family inet unicast
set protocols bgp group UNDERLAY export LO0
set protocols bgp group UNDERLAY neighbor \${peer_p2p_ip} peer-as \${peer_asn}
/* Overlay: eBGP EVPN to the distribution loopback */
set protocols bgp group OVERLAY type external
set protocols bgp group OVERLAY multihop ttl 2
set protocols bgp group OVERLAY local-address \${lo0_ip}
set protocols bgp group OVERLAY family evpn signaling
set protocols bgp group OVERLAY neighbor \${peer_lo0} peer-as \${peer_asn}
/* EVPN-VXLAN */
set protocols evpn encapsulation vxlan
set protocols evpn extended-vni-list all
set switch-options vtep-source-interface lo0.0
set switch-options route-distinguisher \${lo0_ip}:1
set switch-options vrf-target target:65000:1
set vlans V100 vlan-id 100
set vlans V100 vxlan vni 10100
/* A user port in V100 */
set interfaces \${access_port} unit 0 family ethernet-switching interface-mode access
set interfaces \${access_port} unit 0 family ethernet-switching vlan members V100
${JUNOS_END}`,
  },
];

export function templateByLabel(label: string): ConfigTemplate | undefined {
  return CONFIG_TEMPLATES.find((t) => t.label === label);
}
