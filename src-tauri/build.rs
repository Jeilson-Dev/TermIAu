fn main() {
    #[cfg(target_os = "macos")]
    ligar_compiler_rt();

    tauri_build::build()
}

/// O ggml-metal do whisper.cpp usa `@available`, e o clang traduz isso numa
/// chamada a `___isPlatformVersionAtLeast` — função que mora no compiler-rt
/// dele, não na libc nem no `compiler_builtins` do Rust. Como o rustc linka com
/// `-nodefaultlibs`, essa biblioteca não entra sozinha, e o link do release
/// morre em "Undefined symbols for architecture arm64".
///
/// No debug passava, mas por acaso: aquele objeto do whisper foi compilado por
/// um clang anterior, que ainda emitia a função antiga (`___isOSVersionAtLeast`,
/// essa sim já resolvida). Quem recompilar do zero com o Xcode 26 esbarra nisso
/// nos dois perfis.
///
/// O caminho vem do próprio clang em vez de escrito à mão: ele carrega a versão
/// da toolchain (…/clang/17/lib/darwin) e muda a cada Xcode.
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

    // Sem achar o arquivo, o clang devolve o nome cru que recebeu. Aí não há o
    // que linkar, e vale mais deixar o link falhar com a mensagem dele do que
    // apontar para um diretório que não existe.
    let Some(pasta) = arquivo.parent().filter(|_| arquivo.is_file()) else {
        return;
    };

    println!("cargo:rustc-link-search=native={}", pasta.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
