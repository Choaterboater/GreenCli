// The shared temp_dir helper gives every test its own folder, even when many
// tests ask at the same moment (Windows' clock is coarse, so the time alone
// isn't enough).
mod common;

use std::collections::HashSet;

#[test]
fn temp_dirs_made_at_once_are_all_different() {
    let handles: Vec<_> = (0..64)
        .map(|_| std::thread::spawn(|| common::temp_dir("same")))
        .collect();
    let dirs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let unique: HashSet<_> = dirs.iter().collect();
    assert_eq!(unique.len(), dirs.len(), "two tests got the same folder");
    for dir in &dirs {
        std::fs::remove_dir_all(dir).ok();
    }
}
