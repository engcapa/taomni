use super::{actions::Reply, actions::Request, cards, commands, config::Config};
use crate::mobile::{
    Core,
    desktop::{self, WindowInputRequest},
};

pub(super) async fn execute(
    core: &Core,
    config: &Config,
    action: &str,
    target: &str,
    rest: &str,
    p2p_chat: Option<&str>,
    request: Option<&Request>,
) -> Result<Reply, String> {
    match action {
        "screen" => {
            let display = (!target.is_empty()).then_some(target);
            capture_screen_reply(core, config, display, None, p2p_chat).await
        }
        "windows" => {
            let list = desktop::list_windows(core).await?;
            Ok(Reply::Card(cards::windows(config, &list, p2p_chat)))
        }
        "wininput" | "winsend" => {
            let text = request
                .map(|r| r.raw_target.as_str())
                .filter(|v| !v.is_empty())
                .unwrap_or(rest)
                .to_owned();
            if target.is_empty() || text.is_empty() {
                return Err(commands::usage(action));
            }
            let list = desktop::list_windows(core).await?;
            let resolved = desktop::resolve_window(&list, target)?.clone();
            let result = desktop::send_window_input(
                core,
                &resolved.id,
                WindowInputRequest {
                    text,
                    key: None,
                    submit: action == "winsend",
                },
            )
            .await?;
            let note = format!(
                "已向窗口「{}」({}) 发送输入。",
                result.title, result.window_id
            );
            after_desktop_action(core, config, note, p2p_chat).await
        }
        "winkey" => {
            if target.is_empty() || rest.is_empty() {
                return Err(commands::usage(action));
            }
            let list = desktop::list_windows(core).await?;
            let resolved = desktop::resolve_window(&list, target)?.clone();
            let result = desktop::send_window_input(
                core,
                &resolved.id,
                WindowInputRequest {
                    text: String::new(),
                    key: Some(rest.to_owned()),
                    submit: false,
                },
            )
            .await?;
            let note = format!(
                "已向窗口「{}」({}) 发送按键：{}。",
                result.title, result.window_id, rest
            );
            after_desktop_action(core, config, note, p2p_chat).await
        }
        "browser" => {
            if target.is_empty() || !rest.is_empty() {
                return Err(commands::usage("browser"));
            }
            let opened = desktop::open_browser(core, target).await?;
            if core.state().mobile.desktop.screen_allowed() {
                let note = format!("已在服务端浏览器打开：{}", opened.url);
                capture_screen_reply(core, config, None, Some(note), p2p_chat).await
            } else {
                Ok(Reply::Card(cards::browser_opened(
                    config,
                    &opened.url,
                    &opened.window_id,
                    p2p_chat,
                )))
            }
        }
        _ => Err("unknown_desktop_action".into()),
    }
}

async fn after_desktop_action(
    core: &Core,
    config: &Config,
    note: String,
    p2p_chat: Option<&str>,
) -> Result<Reply, String> {
    if core.state().mobile.desktop.screen_allowed() {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        if let Ok(reply) =
            capture_screen_reply(core, config, None, Some(note.clone()), p2p_chat).await
        {
            return Ok(reply);
        }
    }
    Ok(Reply::Text(note))
}

async fn capture_screen_reply(
    core: &Core,
    config: &Config,
    display: Option<&str>,
    subtitle: Option<String>,
    p2p_chat: Option<&str>,
) -> Result<Reply, String> {
    let shot = desktop::capture_screen(core, display).await?;
    let card = cards::screen(
        config,
        &shot.display_name,
        &shot.display_id,
        shot.width,
        shot.height,
        subtitle.as_deref(),
        p2p_chat,
    );
    Ok(Reply::Screen {
        card,
        png: shot.png,
        filename: "screen.png".into(),
    })
}
