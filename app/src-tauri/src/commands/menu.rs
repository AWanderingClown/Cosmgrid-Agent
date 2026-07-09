//! macOS 原生菜单构建 + 语言切换。原生菜单不归前端 i18n 管，必须在 Rust 侧建。

/// 按语言构建 macOS 原生菜单（中/英）。只在 macOS 编译/生效；其它平台保留 Tauri 默认菜单。
#[cfg(target_os = "macos")]
pub(crate) fn build_localized_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    };

    let zh = lang.starts_with("zh");
    // 小助手：按语言二选一
    let l = |z: &'static str, e: &'static str| if zh { z } else { e };

    let app_menu = SubmenuBuilder::new(app, "Cosmgrid Agent")
        .item(&PredefinedMenuItem::about(
            app,
            Some(l("关于 Cosmgrid Agent", "About Cosmgrid Agent")),
            Some(AboutMetadata::default()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(
            app,
            Some(l("服务", "Services")),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(
            app,
            Some(l("隐藏 Cosmgrid Agent", "Hide Cosmgrid Agent")),
        )?)
        .item(&PredefinedMenuItem::hide_others(
            app,
            Some(l("隐藏其他", "Hide Others")),
        )?)
        .item(&PredefinedMenuItem::show_all(
            app,
            Some(l("全部显示", "Show All")),
        )?)
        .separator()
        .item(&PredefinedMenuItem::quit(
            app,
            Some(l("退出 Cosmgrid Agent", "Quit Cosmgrid Agent")),
        )?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, l("编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, Some(l("撤销", "Undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(l("重做", "Redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(l("剪切", "Cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(l("复制", "Copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(l("粘贴", "Paste")))?)
        // 不用 PredefinedMenuItem::select_all：Tauri/WKWebView 下它不会把选区限定在当前
        // 聚焦的输入框内，而是对整个页面执行选择（"全选"变成选中一整屏杂乱内容）。
        // 改成自定义菜单项 + on_menu_event 转发给前端，由前端按 document.activeElement 判断
        // 焦点是否在可编辑元素内，是则只选中该元素内容，不是则忽略。
        .item(
            &MenuItemBuilder::with_id("edit_select_all", l("全选", "Select All"))
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::new(app, l("视图", "View"))
        .item(&PredefinedMenuItem::fullscreen(
            app,
            Some(l("切换全屏", "Toggle Full Screen")),
        )?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, l("窗口", "Window"))
        .item(&PredefinedMenuItem::minimize(
            app,
            Some(l("最小化", "Minimize")),
        )?)
        .item(&PredefinedMenuItem::maximize(app, Some(l("缩放", "Zoom")))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(
            app,
            Some(l("关闭窗口", "Close Window")),
        )?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// 前端在 i18n 初始化和切换语言时调用，按 app 选定语言重建原生菜单。
/// 非 macOS 为 no-op（保留默认菜单）。
#[tauri::command]
pub fn set_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_localized_menu(&app, &lang).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &lang); // 避免未使用告警
    }
    Ok(())
}
