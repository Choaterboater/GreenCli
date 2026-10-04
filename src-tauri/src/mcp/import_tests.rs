// Tests for import.rs. Fixtures in testdata/import use made-up names and
// fake values only.

use super::client::{McpServerDef, McpTransport, McpWrites};
use super::import::*;
use super::presets::{apply_pins, match_preset, plan_pins, PinView, PresetId};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn temp_dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!("greencli-import-test-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn source(
    label: &'static str,
    file_label: &'static str,
    path: PathBuf,
    shape: Shape,
) -> SourceFile {
    SourceFile {
        label,
        file_label,
        path,
        shape,
        max_bytes: 4 * 1024 * 1024,
    }
}

/// Every fixture, lowest precedence first (as default_sources orders them).
fn fixture_sources(dir: &Path) -> Vec<SourceFile> {
    vec![
        source(
            "VS Code",
            "VS Code settings.json",
            write(
                dir,
                "settings.json",
                include_str!("testdata/import/vscode_settings.jsonc"),
            ),
            Shape::VsCodeSettings,
        ),
        source(
            "VS Code",
            "VS Code mcp.json",
            write(
                dir,
                "vscode-mcp.json",
                include_str!("testdata/import/vscode_mcp.jsonc"),
            ),
            Shape::VsCodeMcp,
        ),
        source(
            "~/.mcp.json",
            "~/.mcp.json",
            write(
                dir,
                "home-mcp.json",
                include_str!("testdata/import/home_mcp.json"),
            ),
            Shape::McpServers,
        ),
        source(
            "Claude Code",
            "~/.claude.json",
            write(
                dir,
                "claude.json",
                include_str!("testdata/import/claude.json"),
            ),
            Shape::McpServers,
        ),
        source(
            "Casper",
            "~/.casper/mcp.json",
            write(
                dir,
                "casper.json",
                include_str!("testdata/import/casper_mcp.json"),
            ),
            Shape::McpServers,
        ),
    ]
}

const HOME: &str = "/home/tester";

fn fixture_scan(existing: &[McpServerDef]) -> Scan {
    let dir = temp_dir();
    scan(&fixture_sources(&dir), Path::new(HOME), existing)
}

fn candidate<'a>(s: &'a Scan, name: &str) -> &'a Candidate {
    s.candidates
        .iter()
        .find(|c| c.def.name == name)
        .unwrap_or_else(|| panic!("no candidate {name}: {:?}", names(s)))
}

fn names(s: &Scan) -> Vec<&str> {
    s.candidates.iter().map(|c| c.def.name.as_str()).collect()
}

fn skip_reason<'a>(s: &'a Scan, name: &str) -> &'a str {
    &s.skipped
        .iter()
        .find(|k| k.name == name)
        .unwrap_or_else(|| panic!("no skip for {name}: {:?}", s.skipped))
        .reason
}

/// Some skip for `name` says `needle`.
fn skipped_with(s: &Scan, name: &str, needle: &str) -> bool {
    s.skipped
        .iter()
        .any(|k| k.name == name && k.reason.contains(needle))
}

fn stdio(name: &str, command: &str, args: &[&str]) -> McpServerDef {
    McpServerDef {
        name: name.into(),
        transport: McpTransport::Stdio,
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: HashMap::new(),
        cwd: None,
        url: None,
        credentials_env_var: None,
        headers: HashMap::new(),
        enabled: true,
        writes: None,
        show_opt_in: false,
        wait_for_connect: false,
    }
}

/// One file with one mcpServers map, as a scan of just that file.
fn scan_one(json: &str) -> Scan {
    let dir = temp_dir();
    let path = write(&dir, "one.json", json);
    scan(
        &[source(
            "Casper",
            "~/.casper/mcp.json",
            path,
            Shape::McpServers,
        )],
        Path::new(HOME),
        &[],
    )
}

// ─── JSONC ───

#[test]
fn jsonc_keeps_slashes_inside_strings() {
    let text = r#"{
        // line comment
        "url": "https://x.example/a//b", /* block */ "s": "a /* not */ b",
        "q": "say \"// hi\"",
        "list": [1, 2,],
    }"#;
    let v: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
    assert_eq!(v["url"], "https://x.example/a//b");
    assert_eq!(v["s"], "a /* not */ b");
    assert_eq!(v["q"], "say \"// hi\"");
    assert_eq!(v["list"], serde_json::json!([1, 2]));
    // A comma inside a string before } stays.
    let v: serde_json::Value = serde_json::from_str(&strip_jsonc(r#"{"a": ",}"}"#)).unwrap();
    assert_eq!(v["a"], ",}");
}

// ─── Sources ───

#[test]
fn every_source_shape_parses() {
    let s = fixture_scan(&[]);
    // Casper
    assert_eq!(candidate(&s, "central").source, "Casper");
    assert_eq!(candidate(&s, "lab-netbox").source, "Casper");
    // Claude Code: top level only, never projects[*].
    assert_eq!(candidate(&s, "junos").source, "Claude Code");
    assert!(!names(&s).contains(&"project-only"));
    // ~/.mcp.json
    assert_eq!(candidate(&s, "github").source, "~/.mcp.json");
    // VS Code mcp.json with comments and trailing commas, a URL with // inside.
    let docs = candidate(&s, "docs");
    assert_eq!(docs.source, "VS Code");
    assert_eq!(docs.def.transport, McpTransport::Http);
    assert_eq!(
        docs.def.url.as_deref(),
        Some("https://docs.example.org/mcp")
    );
    assert!(s.problems.is_empty(), "{:?}", s.problems);
}

#[test]
fn imported_servers_are_off_and_not_started() {
    let s = fixture_scan(&[]);
    for c in &s.candidates {
        assert!(!c.def.enabled, "{}", c.def.name);
        assert_eq!(c.def.writes, Some(McpWrites::Off));
        assert!(!c.def.show_opt_in);
    }
}

#[test]
fn casper_extras() {
    let s = fixture_scan(&[]);
    let netbox = candidate(&s, "lab-netbox");
    assert_eq!(
        netbox.def.cwd.as_deref(),
        Some("/home/tester/servers/netbox")
    );
    assert!(netbox.notes.iter().any(|n| n == "it was turned off there"));
    assert!(skip_reason(&s, "project-tool").contains("${PROJECT_ROOT}"));
}

// ─── Variables ───

#[test]
fn variable_rules() {
    let s = fixture_scan(&[]);
    // ${userHome} and ${env:X}: env:X becomes a plain reference, which a program can't use.
    assert!(skip_reason(&s, "home-tool").contains("${HOME_ROOT}"));
    assert!(skip_reason(&s, "asks").contains("asks VS Code for a value"));
    assert!(skip_reason(&s, "folder-tool").contains("${workspaceFolder}"));
    // An env value that is exactly ${NAME} keeps the key empty and is listed under needs;
    // ${NAME:-default} uses the default.
    let github = candidate(&s, "github");
    assert_eq!(github.def.env["GITHUB_PERSONAL_ACCESS_TOKEN"], "");
    assert_eq!(github.needs, vec!["GITHUB_TOKEN".to_string()]);
    assert_eq!(github.def.env["LOG_LEVEL"], "info");
    // "Bearer ${T}" in a header skips the server, naming T.
    assert!(skip_reason(&s, "grafana").contains("${GRAFANA_TOKEN}"));
}

#[test]
fn references_in_program_fields_skip_the_server() {
    for (field, json) in [
        ("args", r#"{"command": "x", "args": ["--token=${T}"]}"#),
        ("command", r#"{"command": "${T}/bin/x"}"#),
        ("cwd", r#"{"command": "x", "cwd": "${T}"}"#),
        ("url", r#"{"type": "http", "url": "https://${T}/mcp"}"#),
    ] {
        let s = scan_one(&format!(r#"{{"mcpServers": {{"s": {json}}}}}"#));
        assert!(s.candidates.is_empty(), "{field}");
        let reason = skip_reason(&s, "s");
        assert!(reason.contains("${T}"), "{field}: {reason}");
    }
    let s = scan_one(
        r#"{"mcpServers": {"s": {"type": "http", "url": "https://h/mcp", "headers": {"Authorization": "Bearer ${T}"}}}}"#,
    );
    assert!(s.candidates.is_empty());
    assert!(skip_reason(&s, "s").contains("${T}"));
    let s = scan_one(
        r#"{"mcpServers": {"s": {"command": "x", "env": {"A": "${T:-x}"}, "args": ["${D:-v}"]}}}"#,
    );
    let c = candidate(&s, "s");
    assert_eq!(c.def.env["A"], "x");
    assert_eq!(c.def.args, vec!["v".to_string()]);
    assert!(c.needs.is_empty());
    let s = scan_one(
        r#"{"mcpServers": {"s": {"type": "http", "url": "https://h/mcp", "headers": {"X-Key": "${env:API_KEY}"}}}}"#,
    );
    let c = candidate(&s, "s");
    assert_eq!(c.def.headers["X-Key"], "");
    assert_eq!(c.needs, vec!["API_KEY".to_string()]);
}

#[test]
fn unsupported_entries_skip_with_a_fixed_reason() {
    let s = fixture_scan(&[]);
    assert!(skip_reason(&s, "old-sse").contains("SSE"));
    assert!(skip_reason(&s, "bad name!").contains("letters, numbers"));
    let s = scan_one(r#"{"mcpServers": {"e": {"command": "x", "envFile": ".env"}, "n": 5}}"#);
    assert!(skip_reason(&s, "e").contains("envFile"));
    assert!(skip_reason(&s, "n").contains("not an object"));
    // More than 64 servers in one file.
    let many: Vec<String> = (0..70)
        .map(|i| format!(r#""s{i}": {{"command": "x{i}"}}"#))
        .collect();
    let s = scan_one(&format!(r#"{{"mcpServers": {{{}}}}}"#, many.join(",")));
    assert_eq!(s.candidates.len(), 64);
    assert!(s.problems.iter().any(|p| p.contains("more than 64")));
}

#[test]
fn values_never_reach_the_preview_or_the_reasons() {
    let s = fixture_scan(&[]);
    let shown = serde_json::to_string(&preview(&s, "t".into())).unwrap();
    for fake in ["fake-casper-secret-0001", "fake-query-0002"] {
        assert!(!shown.contains(fake), "{fake} in {shown}");
    }
    let s = scan_one(
        r#"{"mcpServers": {
            "a": {"command": "x", "args": ["--token=fake-arg-0003-AbCdEfGhIjKl"], "env": {"K": "fake-env-0004"}},
            "b": {"command": "x", "args": ["--api-key", "fake-arg-0005-AbCdEfGhIjKl"], "env": {"K": "fake ${T}"}},
            "c": {"type": "http", "url": "https://u:fake-pass-0006@h.example/mcp?token=fake-q-0007", "headers": {"Authorization": "Bearer fake-hdr-0008"}},
            "d": {"command": "docker", "args": ["run", "-e", "API_TOKEN=fake-env-0009", "img", "ghp_FakeToken0010AbCdEfGhIj"]},
            "e": {"command": "docker", "args": ["run", "--env=NETBOX_PASSWORD=hunter0011", "img"]},
            "f": {"command": "npx", "args": ["mcp-remote", "https://h.example/mcp", "--header", "X-API-Key: sk0012"]},
            "g": {"command": "tool", "args": ["-p", "hunter0013"]},
            "h": {"command": "tool", "args": ["-H", "Authorization:Basic0014"]}
        }}"#,
    );
    let all = serde_json::to_string(&preview(&s, "t".into())).unwrap();
    for fake in [
        "fake-arg-0003",
        "fake-env-0004",
        "fake-arg-0005",
        "fake-pass-0006",
        "fake-q-0007",
        "fake-hdr-0008",
        "fake-env-0009",
        "ghp_FakeToken0010",
        "hunter0011",
        "sk0012",
        "hunter0013",
        "Basic0014",
    ] {
        assert!(!all.contains(fake), "{fake} in {all}");
    }
}

#[test]
fn runs_line_shows_the_program_and_masks_secrets() {
    let mut d = stdio(
        "s",
        "/usr/local/bin/uvx",
        &["centralmcp", "--token=abcDEF1234567890xyzQRS"],
    );
    assert_eq!(runs_line(&d), "uvx centralmcp --token=…");
    d.args = vec![
        "--password".into(),
        "hunter2".into(),
        "--port".into(),
        "8080".into(),
    ];
    assert_eq!(runs_line(&d), "uvx --password … --port 8080");
    let mut h = stdio("h", "", &[]);
    h.transport = McpTransport::Http;
    h.url = Some("https://user:pw@mcp.example.com:8443/path?key=x".into());
    assert_eq!(runs_line(&h), "https://mcp.example.com:8443");
    // Paths, package names and numbers still show.
    let d = stdio(
        "d",
        "docker",
        &[
            "run",
            "-i",
            "--rm",
            "--env=TZ=UTC",
            "-v",
            "/data:/data",
            "ghcr.io/acme/mcp:1.2",
            "--transport",
            "stdio",
        ],
    );
    assert_eq!(
        runs_line(&d),
        "docker run -i --rm --env=TZ=… -v /data:/data ghcr.io/acme/mcp:1.2 --transport stdio"
    );
    let r = stdio(
        "r",
        "npx",
        &[
            "mcp-remote",
            "https://h.example/mcp",
            "--header",
            "X-Key: abc",
        ],
    );
    assert_eq!(runs_line(&r), "npx mcp-remote https://h.example --header …");
}

#[test]
fn two_tenants_of_one_program_both_come_in() {
    let s = scan_one(
        r#"{"mcpServers": {
            "central-prod": {"command": "uvx", "args": ["central-mcp-server"], "env": {"CLIENT_ID": "prod"}},
            "central-lab": {"command": "uvx", "args": ["central-mcp-server"], "env": {"CLIENT_ID": "lab"}},
            "mist-a": {"type": "http", "url": "https://mist.example/mcp", "headers": {"Authorization": "Bearer a"}},
            "mist-b": {"type": "http", "url": "https://mist.example/mcp", "headers": {"Authorization": "Bearer b"}}
        }}"#,
    );
    let mut got = names(&s);
    got.sort();
    assert_eq!(got.len(), 4, "{got:?} {:?}", s.skipped);
    assert!(got.contains(&"central-prod") && got.contains(&"central-lab"));
    assert!(got.contains(&"mist-a") && got.contains(&"mist-b"));
    // One already in GreenCLI with other values does not hide the other tenant.
    let mut have = stdio("central", "uvx", &["central-mcp-server"]);
    have.env.insert("CLIENT_ID".into(), "prod".into());
    let dir = temp_dir();
    let path = write(
        &dir,
        "one.json",
        r#"{"mcpServers": {
            "central-prod": {"command": "uvx", "args": ["central-mcp-server"], "env": {"CLIENT_ID": "prod"}},
            "central-lab": {"command": "uvx", "args": ["central-mcp-server"], "env": {"CLIENT_ID": "lab"}}
        }}"#,
    );
    let s = scan(
        &[source(
            "Casper",
            "~/.casper/mcp.json",
            path,
            Shape::McpServers,
        )],
        Path::new(HOME),
        &[have],
    );
    assert_eq!(names(&s), vec!["central-lab"]);
    assert!(skipped_with(
        &s,
        "central-prod",
        "already in GreenCLI as central"
    ));
}

// ─── Precedence and skips ───

#[test]
fn later_sources_win() {
    let s = fixture_scan(&[]);
    // central is in Claude Code and Casper: Casper wins.
    let central = candidate(&s, "central");
    assert_eq!(central.source, "Casper");
    assert_eq!(central.def.args, vec!["centralmcp".to_string()]);
    // junos is in VS Code and Claude Code: Claude Code wins.
    assert_eq!(candidate(&s, "junos").source, "Claude Code");
    let lower: Vec<&Skipped> = s.skipped.iter().filter(|k| k.name == "junos").collect();
    assert_eq!(lower.len(), 1);
    assert_eq!(lower[0].source, "VS Code");
    assert!(lower[0].reason.contains("Claude Code"));
    // Highest precedence first in the list.
    assert_eq!(s.candidates[0].source, "Casper");
}

#[test]
fn greencli_own_server_is_skipped() {
    let s = fixture_scan(&[]);
    assert!(skip_reason(&s, "greencli").contains("GreenCLI's own server"));
    assert!(skip_reason(&s, "renamed-own").contains("GreenCLI's own server"));
}

#[test]
fn existing_servers_are_skipped() {
    let mut my_central = stdio("my-central", "uvx", &["centralmcp"]);
    my_central.env.insert(
        "CENTRAL_CLIENT_SECRET".into(),
        "fake-casper-secret-0001".into(),
    );
    let existing = [stdio("junos", "something", &["else"]), my_central];
    let s = fixture_scan(&existing);
    assert!(!names(&s).contains(&"junos"));
    assert!(skipped_with(&s, "junos", "already in GreenCLI"));
    assert!(!names(&s).contains(&"central"));
    assert!(skipped_with(&s, "central", "my-central"));
}

#[test]
fn same_program_under_two_names_comes_in_once() {
    let dir = temp_dir();
    let low = write(
        &dir,
        "a.json",
        r#"{"mcpServers": {"nb": {"command": "netbox-mcp"}}}"#,
    );
    let high = write(
        &dir,
        "b.json",
        r#"{"mcpServers": {"netbox": {"command": "netbox-mcp"}}}"#,
    );
    let s = scan(
        &[
            source("~/.mcp.json", "~/.mcp.json", low, Shape::McpServers),
            source("Casper", "~/.casper/mcp.json", high, Shape::McpServers),
        ],
        Path::new(HOME),
        &[],
    );
    assert_eq!(names(&s), vec!["netbox"]);
    assert!(skip_reason(&s, "nb").contains("netbox"));
}

#[test]
fn bad_files_never_panic() {
    let dir = temp_dir();
    let big = write(&dir, "big.json", &" ".repeat(2048));
    let bad = write(&dir, "bad.json", "{ not json");
    let folder = dir.join("folder.json");
    std::fs::create_dir_all(&folder).unwrap();
    let mut sources = vec![
        source("Casper", "big.json", big, Shape::McpServers),
        source("Casper", "bad.json", bad, Shape::McpServers),
        source("Casper", "folder.json", folder, Shape::McpServers),
        source(
            "Casper",
            "missing.json",
            dir.join("missing.json"),
            Shape::McpServers,
        ),
    ];
    sources[0].max_bytes = 1024;
    let s = scan(&sources, Path::new(HOME), &[]);
    assert!(s.candidates.is_empty());
    assert_eq!(s.problems.len(), 3, "{:?}", s.problems);
    assert!(s.problems[0].contains("larger than"));
    assert!(s.problems[1].contains("not valid JSON"));
    assert!(s.problems[2].contains("Can't read folder.json"));
}

#[test]
fn default_sources_order_and_caps() {
    let home = Path::new(HOME);
    let sources = default_sources(home);
    let labels: Vec<&str> = sources.iter().map(|s| s.label).collect();
    let n = labels.len();
    assert_eq!(&labels[n - 3..], &["~/.mcp.json", "Claude Code", "Casper"]);
    assert!(labels[..n - 3].iter().all(|l| l.starts_with("VS Code")));
    let claude = &sources[n - 2];
    assert_eq!(claude.path, home.join(".claude.json"));
    assert_eq!(claude.max_bytes, 32 * 1024 * 1024);
    assert_eq!(sources[n - 1].path, home.join(".casper").join("mcp.json"));
    assert!(sources
        .iter()
        .filter(|s| s.label != "Claude Code")
        .all(|s| s.max_bytes == 4 * 1024 * 1024));
}

// ─── Pins on a round trip ───

#[test]
fn baked_in_pins_from_an_export_are_taken_out() {
    // GreenCLI's export of a docker HPE server while writes were off.
    let mut args = vec!["run", "-i", "--rm"];
    let pairs: Vec<String> = [
        ("HPE_MCP_ACCESS_PROFILE", "safe-read-only"),
        ("HPE_MCP_READONLY", "1"),
        ("HPE_MCP_PRODUCT_ACCESS", "read-only"),
        ("HPE_MCP_CENTRAL_WRITES", "0"),
        ("HPE_MCP_GLP_V2BETA1_WRITES", "0"),
        ("HPE_MCP_AOS8_WRITES", "0"),
        ("HPE_MCP_EDGECONNECT_WRITES", "0"),
        ("HPE_MCP_APSTRA_WRITES", "0"),
        ("HPE_MCP_MIST_WRITES", "0"),
        ("HPE_MCP_CLEARPASS_WRITES", "0"),
        ("HPE_MCP_UXI_WRITES", "0"),
        ("HPE_MCP_AXIS_WRITES", "0"),
        ("HPE_MCP_AOS8_ROLLBACK_WRITES", "0"),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={v}"))
    .collect();
    for p in &pairs {
        args.push("-e");
        args.push(p);
    }
    args.push("hpe-mcp-router");
    let json =
        serde_json::json!({ "mcpServers": { "hpe": { "command": "docker", "args": args } } });
    let s = scan_one(&json.to_string());
    let c = candidate(&s, "hpe");
    assert_eq!(c.def.args, vec!["run", "-i", "--rm", "hpe-mcp-router"]);
    assert!(c
        .notes
        .iter()
        .any(|n| n.contains("earlier GreenCLI export")));
    // With writes on nothing read-only remains; with writes off GreenCLI adds them back once.
    assert!(!c.def.args.iter().any(|a| a.contains("READONLY")));
    let plan = plan_pins(&c.def, PresetId::HpeNetworkingMcp);
    let mut started = c.def.clone();
    apply_pins(&mut started, &plan);
    assert_eq!(
        started
            .args
            .iter()
            .filter(|a| *a == "HPE_MCP_READONLY=1")
            .count(),
        1
    );

    // Grafana with --disable-write appended, centralmcp with its env key.
    let s = scan_one(
        r#"{"mcpServers": {
            "g": {"command": "mcp-grafana", "args": ["--disable-write"]},
            "c": {"command": "uvx", "args": ["centralmcp"], "env": {"CENTRALMCP_READONLY": "1", "OTHER": "x"}}
        }}"#,
    );
    assert!(candidate(&s, "g").def.args.is_empty());
    let c = candidate(&s, "c");
    assert!(!c.def.env.contains_key("CENTRALMCP_READONLY"));
    assert_eq!(c.def.env["OTHER"], "x");
}

#[test]
fn a_lone_read_only_key_is_kept() {
    // One HPE key the person set, not the whole set GreenCLI's export writes.
    let s = scan_one(
        r#"{"mcpServers": {"hpe": {"command": "python", "args": ["tool_router.py"], "env": {"HPE_MCP_READONLY": "1"}}}}"#,
    );
    let c = candidate(&s, "hpe");
    assert_eq!(c.def.env["HPE_MCP_READONLY"], "1");
    assert!(c.notes.iter().any(|n| n.contains("HPE_MCP_READONLY=1")));
}

#[test]
fn a_pin_that_names_the_server_stays() {
    // Mist's local server found only by its MIST_READ_ONLY key: taking it out would hide what it is.
    let s = scan_one(
        r#"{"mcpServers": {"m": {"command": "uv", "args": ["run", "server.py"], "env": {"MIST_READ_ONLY": "1"}}}}"#,
    );
    let c = candidate(&s, "m");
    assert_eq!(c.def.env["MIST_READ_ONLY"], "1");
    assert_eq!(
        match_preset(&c.def, None).map(|m| m.id),
        Some(PresetId::MistMcp)
    );
}

#[test]
fn preview_shows_pins_and_cannot_pin_reasons() {
    let s = fixture_scan(&[]);
    let p = preview(&s, "tok".into());
    assert_eq!(p.token, "tok");
    let item = |n: &str| p.items.iter().find(|i| i.name == n).unwrap();
    let central = item("central");
    assert_eq!(central.preset.as_deref(), Some("Central"));
    assert_eq!(
        central.pins,
        PinView::Pinned {
            shown: vec!["CENTRALMCP_READONLY=1".into()],
            confirmed: false
        }
    );
    assert_eq!(
        item("junos").pins,
        PinView::CannotPin {
            reason: "it has no read-only setting".into()
        }
    );
    assert_eq!(item("github").needs, vec!["GITHUB_TOKEN".to_string()]);
    assert_eq!(
        item("github").runs,
        "npx -y @modelcontextprotocol/server-github"
    );
    assert_eq!(item("docs").transport, "http");
    assert_eq!(item("docs").id, "docs");
    // mist-mcp gets its pin.
    let s = scan_one(r#"{"mcpServers": {"mist": {"command": "uvx", "args": ["mist-mcp"]}}}"#);
    let p = preview(&s, "t".into());
    assert_eq!(
        p.items[0].pins,
        PinView::Pinned {
            shown: vec!["MIST_READ_ONLY=1".into()],
            confirmed: false
        }
    );
}

// ─── The kept list ───

#[test]
fn the_book_imports_exactly_what_was_shown() {
    let book = ImportBook::default();
    let first = book.keep(fixture_scan(&[]));
    let ids: Vec<String> = first.items.iter().map(|i| i.id.clone()).collect();
    assert!(book.take("wrong", &ids).is_err());
    assert_eq!(
        book.take(&first.token, &["nope".to_string()]).unwrap_err(),
        STALE
    );
    // A newer scan (the button while the offer is open) leaves the older
    // one usable.
    let second = book.keep(fixture_scan(&[]));
    assert_ne!(first.token, second.token);
    assert_eq!(
        book.take(&first.token, &["central".to_string()])
            .unwrap()
            .len(),
        1
    );
    assert_eq!(book.take(&first.token, &ids).unwrap_err(), STALE);
    // Only the last few are kept.
    for _ in 0..8 {
        book.keep(fixture_scan(&[]));
    }
    assert_eq!(book.take(&second.token, &ids).unwrap_err(), STALE);
    let second = book.keep(fixture_scan(&[]));
    let defs = book.take(&second.token, &["github".to_string()]).unwrap();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].name, "github");
    // One time only.
    assert_eq!(
        book.take(&second.token, &["github".to_string()])
            .unwrap_err(),
        STALE
    );
}
