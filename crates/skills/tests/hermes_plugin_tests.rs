//! The Hermes design-hook plugin install (#1178): Hermes loads plugins only
//! from its home dir, so project and global installs both copy there.

use impeccable_skills::hook_manifest::{copy_provider_hooks, hook_installed_for_provider};
use impeccable_skills::providers::Sys;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const PLUGIN: &str = ".hermes/plugins/impeccable-design-hook";

struct Fixture {
    root: PathBuf,
    bundle: String,
    home: String,
    project: String,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let root = std::env::temp_dir().join(format!("imp-hermes-{name}-{}-{nanos}", std::process::id()));
        let bundle = root.join("bundle");
        std::fs::create_dir_all(bundle.join(PLUGIN)).unwrap();
        std::fs::write(bundle.join(PLUGIN).join("plugin.yaml"), "name: impeccable-design-hook\n").unwrap();
        std::fs::write(bundle.join(PLUGIN).join("__init__.py"), "def register(ctx):\n    pass\n").unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("project")).unwrap();
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        Fixture { bundle: s(bundle), home: s(root.join("home")), project: s(root.join("project")), root }
    }

    fn sys(&self, hermes_home: Option<&str>) -> Sys {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), self.home.clone());
        env.insert("USERPROFILE".to_string(), self.home.clone());
        if let Some(h) = hermes_home {
            env.insert("HERMES_HOME".to_string(), h.to_string());
        }
        Sys::new(env, self.project.clone())
    }

    fn install(&self, sys: &Sys) -> Result<Vec<&'static str>, String> {
        copy_provider_hooks(sys, &self.bundle, &self.project, &[".hermes"], false, None, None)
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }
}

/// The installer's own "already installed" check, routed for `.hermes`.
fn installed(f: &Fixture, sys: &Sys) -> bool {
    hook_installed_for_provider(sys, &f.project, ".hermes")
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn project_install_writes_the_plugin_under_the_hermes_home() {
    let f = Fixture::new("project");
    let sys = f.sys(None);
    assert!(!installed(&f, &sys));
    assert_eq!(f.install(&sys).unwrap(), vec![".hermes"]);
    assert_eq!(f.read(&format!("home/{PLUGIN}/plugin.yaml")), "name: impeccable-design-hook\n");
    assert!(f.read(&format!("home/{PLUGIN}/__init__.py")).contains("def register"));
    assert!(!Path::new(&f.project).join(".hermes").exists(), "never a project-local plugin");
    assert!(installed(&f, &sys));
    // Idempotent.
    assert_eq!(f.install(&sys).unwrap(), vec![".hermes"]);
    assert!(f.read(&format!("home/{PLUGIN}/__init__.py")).contains("def register"));
}

#[test]
fn hermes_home_redirects_only_under_home() {
    let f = Fixture::new("hermes-home");
    let custom = f.root.join("home/custom-hermes").to_string_lossy().into_owned();
    f.install(&f.sys(Some(&custom))).unwrap();
    assert!(f.root.join("home/custom-hermes/plugins/impeccable-design-hook/__init__.py").is_file());
    assert!(!f.root.join(format!("home/{PLUGIN}")).exists());

    let outside = f.root.join("elsewhere").to_string_lossy().into_owned();
    let sys = f.sys(Some(&outside));
    f.install(&sys).unwrap();
    assert!(!f.root.join("elsewhere").exists());
    assert!(f.root.join(format!("home/{PLUGIN}/__init__.py")).is_file());
    assert!(installed(&f, &sys));
}

#[test]
fn a_partial_plugin_is_repaired() {
    let f = Fixture::new("partial");
    let sys = f.sys(None);
    std::fs::create_dir_all(f.root.join(format!("home/{PLUGIN}"))).unwrap();
    std::fs::write(f.root.join(format!("home/{PLUGIN}/plugin.yaml")), "stale\n").unwrap();
    assert!(!installed(&f, &sys));
    f.install(&sys).unwrap();
    assert_eq!(f.read(&format!("home/{PLUGIN}/plugin.yaml")), "name: impeccable-design-hook\n");
    assert!(installed(&f, &sys));
}

#[test]
fn a_bundle_without_the_plugin_is_skipped() {
    // A bundle from before the plugin, like a bundle without a provider's
    // manifest: nothing written, nothing reported.
    let f = Fixture::new("absent");
    std::fs::remove_dir_all(Path::new(&f.bundle).join(PLUGIN)).unwrap();
    let sys = f.sys(None);
    assert_eq!(f.install(&sys).unwrap(), Vec::<&str>::new());
    assert!(!f.root.join(format!("home/{PLUGIN}")).exists());
    assert!(!installed(&f, &sys));
}

#[test]
fn a_bundle_with_half_the_plugin_errors() {
    let f = Fixture::new("missing");
    std::fs::remove_file(Path::new(&f.bundle).join(PLUGIN).join("__init__.py")).unwrap();
    let sys = f.sys(None);
    let err = f.install(&sys).unwrap_err();
    assert!(err.contains("__init__.py"), "{err}");
    assert!(!f.root.join(format!("home/{PLUGIN}")).exists());
    assert!(!installed(&f, &sys));
}
