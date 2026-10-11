fn main() {
    #[cfg(target_os = "macos")]
    ligar_compiler_rt();

    tauri_build::build()
}

/// whisper.cpp's ggml-metal uses `@available`, and clang turns that into a
/// call to `___isPlatformVersionAtLeast` — a function that lives in its
/// compiler-rt, not in libc nor in Rust's `compiler_builtins`. Since rustc links with
/// `-nodefaultlibs`, that library doesn't come in on its own, and the release link
/// dies with "Undefined symbols for architecture arm64".
///
/// Debug worked, but by chance: that whisper object was compiled by
/// an earlier clang, which still emitted the old function (`___isOSVersionAtLeast`,
/// which is already resolved). Anyone rebuilding from scratch with Xcode 26 hits this
/// in both profiles.
///
/// The path comes from clang itself instead of being hardcoded: it carries the
/// toolchain version (…/clang/17/lib/darwin) and changes with every Xcode.
#[cfg(target_os = "macos")]
fn ligar_compiler_rt() {
    println!("cargo:rerun-if-changed=build.rs");

    let Ok(saida) = std::process::Command::new("cc")
        .arg("--print-file-name=libclang_rt.osx.a")
        .output()
    else {
        return;
    };
    let caminho = String::from_utf8_lossy(&saida.stdout).trim().to_string();
    let arquivo = std::path::Path::new(&caminho);

    // When it can't find the file, clang returns the raw name it got. Then there is
    // nothing to link, and it is better to let the link fail with its own message than
    // to point to a directory that doesn't exist.
    let Some(pasta) = arquivo.parent().filter(|_| arquivo.is_file()) else {
        return;
    };

    println!("cargo:rustc-link-search=native={}", pasta.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
