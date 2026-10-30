fn main() {
    // 图标是编译期嵌进 exe 资源的（resource.rc 里的 32512 ICON）。
    // 不显式声明这条依赖的话，替换 icons/ 里的文件不会触发 build script 重跑，
    // exe 会继续用旧图标，表现为「换了图标重启也没变」。
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
